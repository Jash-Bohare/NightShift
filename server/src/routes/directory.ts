// Directory routes: GET /directory and GET /directory/:identifier
import { Router } from "express";
import { z } from "zod";
import { big, db } from "../db/client.js";
import { syncAgentToDirectory } from "../ens/indexer.js";
import { ApiError, UpstreamError } from "../errors.js";

export const directoryRouter = Router();

const DirectoryQuery = z.object({
  skill: z.string().optional(),
  capability: z.string().optional(),
  task: z.string().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  search: z.string().optional(),
  status: z.string().default("active"),
  sort: z.enum(["reputation", "price", "price_asc", "price_desc", "recent"]).default("reputation"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

/** Maps human-readable capability/task queries to standard skill prefixes */
function normalizeSkillFilter(skill?: string, capability?: string, task?: string): string | undefined {
  const query = skill || capability || task;
  if (!query) return undefined;
  const q = query.toLowerCase().trim();
  if (q.includes("transcri") || q.includes("audio")) {
    if (q.includes(":ta") || q.includes("tamil")) return "transcribe:ta";
    if (q.includes(":hi") || q.includes("hindi")) return "transcribe:hi";
    if (q.includes(":en") || q.includes("english")) return "transcribe:en";
    return "transcribe";
  }
  return q;
}

directoryRouter.get("/directory", async (req, res) => {
  const parsed = DirectoryQuery.safeParse(req.query);
  if (!parsed.success) {
    throw new ApiError(422, "invalid_query", "Invalid directory query parameters", parsed.error.issues);
  }

  const { maxPrice, search, status, sort, page, limit } = parsed.data;
  const skillFilter = normalizeSkillFilter(parsed.data.skill, parsed.data.capability, parsed.data.task);

  let query = db.from("directory").select("*", { count: "exact" });

  if (status && status !== "all") {
    query = query.eq("status", status);
  }

  if (skillFilter) {
    if (skillFilter.includes(":")) {
      query = query.eq("skill", skillFilter);
    } else {
      query = query.ilike("skill", `${skillFilter}%`);
    }
  }

  if (maxPrice !== undefined) {
    query = query.lte("price_atomic", maxPrice);
  }

  if (search) {
    const s = search.toLowerCase().trim();
    query = query.or(`label.ilike.%${s}%,ens_name.ilike.%${s}%,description.ilike.%${s}%`);
  }

  // Sorting
  if (sort === "price" || sort === "price_asc") {
    query = query.order("price_atomic", { ascending: true });
  } else if (sort === "price_desc") {
    query = query.order("price_atomic", { ascending: false });
  } else if (sort === "recent") {
    query = query.order("updated_at", { ascending: false });
  } else {
    // Default: reputation sort
    query = query.order("updated_at", { ascending: false });
  }

  // Pagination
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  query = query.range(from, to);

  const { data, count, error } = await query;
  if (error) {
    throw new UpstreamError("db", error.message);
  }

  let rows = (data ?? []).map((row) => ({
    label: row.label,
    ensName: row.ens_name,
    owner: row.owner,
    resolver: row.resolver,
    skill: row.skill,
    capabilities: row.skill ? [row.skill.split(":")[0]] : [],
    supportedTasks: row.skill ? [row.skill] : [],
    price: {
      amount: row.price_atomic !== null ? big(row.price_atomic).toString() : null,
      unit: row.price_unit,
    },
    priceAtomic: row.price_atomic !== null ? big(row.price_atomic).toString() : null,
    payTo: row.payto,
    endpoint: row.endpoint,
    model: row.model,
    description: row.description,
    reputation: row.reputation,
    status: row.status,
    updatedAt: row.updated_at,
  }));

  // In-memory refinement for reputation scoring if requested
  if (sort === "reputation") {
    rows.sort((a, b) => {
      const repA = a.reputation?.success ?? 0;
      const repB = b.reputation?.success ?? 0;
      if (repB !== repA) return repB - repA;
      const jobsA = a.reputation?.jobs ?? 0;
      const jobsB = b.reputation?.jobs ?? 0;
      return jobsB - jobsA;
    });
  }

  res.json({
    success: true,
    data: {
      agents: rows,
      pagination: {
        page,
        limit,
        total: count ?? rows.length,
      },
    },
    // Top-level aliases for compatibility with different client styles
    agents: rows,
    total: count ?? rows.length,
  });
});

directoryRouter.get("/directory/:identifier", async (req, res) => {
  const raw = req.params.identifier.trim();
  const label = raw.replace(/\.nightshift\.eth$/, "");

  let { data, error } = await db
    .from("directory")
    .select("*")
    .or(`label.eq.${label},ens_name.eq.${raw}`)
    .maybeSingle();

  if (error) throw new UpstreamError("db", error.message);

  // If not found in directory cache, attempt live on-chain sync
  if (!data) {
    const ok = await syncAgentToDirectory(label);
    if (ok) {
      const fresh = await db.from("directory").select("*").eq("label", label).maybeSingle();
      data = fresh.data;
    }
  }

  if (!data) {
    throw new ApiError(404, "not_found", `Agent ${raw} not found in directory`);
  }

  const agent = {
    label: data.label,
    ensName: data.ens_name,
    owner: data.owner,
    resolver: data.resolver,
    skill: data.skill,
    capabilities: data.skill ? [data.skill.split(":")[0]] : [],
    supportedTasks: data.skill ? [data.skill] : [],
    price: {
      amount: data.price_atomic !== null ? big(data.price_atomic).toString() : null,
      unit: data.price_unit,
    },
    priceAtomic: data.price_atomic !== null ? big(data.price_atomic).toString() : null,
    payTo: data.payto,
    endpoint: data.endpoint,
    model: data.model,
    description: data.description,
    reputation: data.reputation,
    status: data.status,
    lastBlock: data.last_block,
    updatedAt: data.updated_at,
  };

  res.json({
    success: true,
    data: agent,
    ...agent,
  });
});
