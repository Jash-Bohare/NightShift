// In-memory stand-in for the supabase-js service-role client, used ONLY by the simulated
// end-to-end tests. It implements the PostgREST query subset the server uses, the unique
// constraints that guard replay/idempotency (23505), and JS mirrors of the budget RPCs from
// migrations 0005/0006. The real SQL is validated separately against Postgres
// (supabase/tests/migrations.test.ts); this fake is not evidence of database behaviour.
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number };

const UNIQUE: Record<string, string[][]> = {
  owners: [["id"], ["privy_user_id"]],
  agents: [["id"], ["label"], ["ens_name"]],
  agent_secrets: [["agent_id"]],
  jobs: [["id"]],
  payouts: [["id"], ["agent_id", "payout_date"]],
  quote_redemptions: [["nonce"], ["job_id"]],
  settlement_recoveries: [["id"], ["job_id"]],
  agent_budget_reservations: [["id"]],
  directory: [["label"]],
  buyer_events: [["id"]],
  indexer_state: [["id"]],
};

/** child table -> (foreign key on child, parent table) */
const MANY_TO_ONE: Record<string, Record<string, { fk: string; table: string }>> = {
  jobs: { agents: { fk: "agent_id", table: "agents" } },
  payouts: { agents: { fk: "agent_id", table: "agents" } },
  quote_redemptions: { agents: { fk: "agent_id", table: "agents" } },
};
/** parent table -> (child table keyed by fk = parent.id), one-to-one */
const ONE_TO_ONE: Record<string, Record<string, { fk: string }>> = {
  agents: { agent_secrets: { fk: "agent_id" } },
};

interface Field {
  name: string;
  inner: boolean;
  children?: Field[];
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseSelect(s: string): Field[] {
  return splitTop(s).map((part) => {
    const m = /^([a-z0-9_*]+)(!inner)?(?:\((.*)\))?$/s.exec(part);
    if (!m) throw new Error(`fake-supabase: unsupported select ${part}`);
    return {
      name: m[1]!,
      inner: Boolean(m[2]),
      ...(m[3] !== undefined ? { children: parseSelect(m[3]) } : {}),
    };
  });
}

type Filter = { path: string; op: string; value: unknown };

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" || typeof b === "number" || /^-?\d+$/.test(String(a)))
    if (/^-?\d+(\.\d+)?$/.test(String(a)) && /^-?\d+(\.\d+)?$/.test(String(b)))
      return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function test(value: unknown, f: Filter): boolean {
  switch (f.op) {
    case "eq":
      return value !== undefined && value !== null && String(value) === String(f.value);
    case "neq":
      return String(value) !== String(f.value);
    case "in":
      return (f.value as unknown[]).map(String).includes(String(value));
    case "gte":
      return value !== null && value !== undefined && cmp(value, f.value) >= 0;
    case "gt":
      return value !== null && value !== undefined && cmp(value, f.value) > 0;
    case "lte":
      return value !== null && value !== undefined && cmp(value, f.value) <= 0;
    case "lt":
      return value !== null && value !== undefined && cmp(value, f.value) < 0;
    default:
      throw new Error(`fake-supabase: unsupported filter ${f.op}`);
  }
}

export class FakeSupabase {
  readonly tables: Record<string, Row[]> = {};
  readonly rpcCalls: { name: string; args: Row }[] = [];
  now: () => Date = () => new Date();

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  seed(name: string, rows: Row[]): void {
    for (const row of rows) this.table(name).push(this.withDefaults(name, { ...row }));
  }

  private withDefaults(name: string, row: Row): Row {
    const ts = this.now().toISOString();
    if (
      name !== "agent_secrets" &&
      name !== "directory" &&
      name !== "indexer_state" &&
      !("id" in row) &&
      name !== "quote_redemptions"
    )
      row.id = randomUUID();
    if (!("created_at" in row)) row.created_at = ts;
    if (name === "quote_redemptions" || name === "settlement_recoveries" || name === "payouts")
      row.updated_at ??= ts;
    return row;
  }

  private violates(name: string, row: Row, ignore?: Row): string | null {
    for (const cols of UNIQUE[name] ?? []) {
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      const clash = this.table(name).find(
        (other) => other !== ignore && cols.every((c) => String(other[c]) === String(row[c])),
      );
      if (clash) return cols.join(",");
    }
    return null;
  }

  from(name: string): QueryBuilder {
    return new QueryBuilder(this, name);
  }

  rpc(name: string, args: Row): Promise<Result> {
    this.rpcCalls.push({ name, args });
    try {
      return Promise.resolve({ data: this.runRpc(name, args), error: null });
    } catch (error) {
      return Promise.resolve({ data: null, error: { message: (error as Error).message } });
    }
  }

  private spentToday(agentId: string): bigint {
    const day = new Date(this.now());
    day.setUTCHours(0, 0, 0, 0);
    return this.table("jobs")
      .filter((j) => j.agent_id === agentId && String(j.created_at) >= day.toISOString())
      .reduce((s, j) => s + BigInt(String(j.zg_cost_usd_micro ?? 0)), 0n);
  }

  private runRpc(name: string, args: Row): unknown {
    const reservations = this.table("agent_budget_reservations");
    const now = this.now().getTime();
    switch (name) {
      case "reserve_agent_budget": {
        const amount = BigInt(String(args.p_amount_usd_micro));
        if (amount <= 0n) throw new Error("reservation amount must be positive");
        const agent = this.table("agents").find((a) => a.id === args.p_agent_id);
        if (!agent) throw new Error("agent not found");
        this.tables.agent_budget_reservations = reservations.filter(
          (r) => Date.parse(String(r.expires_at)) > now,
        );
        const reserved = this.table("agent_budget_reservations")
          .filter((r) => r.agent_id === agent.id)
          .reduce((s, r) => s + BigInt(String(r.amount_usd_micro)), 0n);
        if (
          this.spentToday(String(agent.id)) + reserved + amount >
          BigInt(String(agent.daily_cap_usd_micro))
        )
          return null;
        const id = randomUUID();
        this.table("agent_budget_reservations").push({
          id,
          agent_id: agent.id,
          amount_usd_micro: amount.toString(),
          expires_at: new Date(now + 15 * 60_000).toISOString(),
          created_at: new Date(now).toISOString(),
        });
        return id;
      }
      case "release_agent_budget": {
        const before = reservations.length;
        this.tables.agent_budget_reservations = reservations.filter(
          (r) => r.id !== args.p_reservation_id,
        );
        return this.table("agent_budget_reservations").length === before - 1;
      }
      case "retain_uncertain_agent_budget": {
        const r = reservations.find((x) => x.id === args.p_reservation_id);
        if (!r) return false;
        const agent = this.table("agents").find((a) => a.id === r.agent_id)!;
        const remaining =
          BigInt(String(agent.daily_cap_usd_micro)) - this.spentToday(String(agent.id));
        const amount = BigInt(String(r.amount_usd_micro));
        r.amount_usd_micro = (amount > remaining ? amount : remaining).toString();
        r.expires_at = new Date(now + 365 * 86_400_000).toISOString();
        return true;
      }
      default:
        throw new Error(`fake-supabase: rpc ${name} is not simulated`);
    }
  }

  // ---- internals used by QueryBuilder

  embed(table: string, row: Row, fields: Field[]): Row | null {
    if (fields.length === 1 && fields[0]!.name === "*" && !fields[0]!.children) return { ...row };
    const out: Row = {};
    for (const f of fields) {
      if (!f.children) {
        if (f.name === "*") Object.assign(out, row);
        else out[f.name] = row[f.name] ?? null;
        continue;
      }
      const m2o = MANY_TO_ONE[table]?.[f.name];
      const o2o = ONE_TO_ONE[table]?.[f.name];
      let related: Row | undefined;
      if (m2o) related = this.table(m2o.table).find((p) => p.id === row[m2o.fk]);
      else if (o2o) related = this.table(f.name).find((c) => c[o2o.fk] === row.id);
      else throw new Error(`fake-supabase: unknown relationship ${table}.${f.name}`);
      const value = related ? this.embed(m2o ? m2o.table : f.name, related, f.children) : null;
      if (f.inner && !value) return null;
      out[f.name] = value;
    }
    return out;
  }

  insertRows(table: string, rows: Row[], upsertOn?: string): Result {
    const stored: Row[] = [];
    for (const raw of rows) {
      const row = { ...raw };
      if (upsertOn) {
        const keys = upsertOn.split(",");
        const existing = this.table(table).find((o) =>
          keys.every((k) => String(o[k]) === String(row[k])),
        );
        if (existing) {
          Object.assign(existing, row);
          stored.push(existing);
          continue;
        }
      }
      this.withDefaults(table, row);
      const clash = this.violates(table, row);
      if (clash)
        return {
          data: null,
          error: {
            code: "23505",
            message: `duplicate key value violates unique constraint (${table}.${clash})`,
          },
        };
      this.table(table).push(row);
      stored.push(row);
    }
    return { data: stored, error: null };
  }
}

class QueryBuilder implements PromiseLike<Result> {
  private fields: Field[] = [{ name: "*", inner: false }];
  private filters: Filter[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private rangeFrom = 0;
  private rangeTo = Number.POSITIVE_INFINITY;
  private mode: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row[] = [];
  private patch: Row = {};
  private upsertOn?: string;
  private returning = false;
  private cardinality: "many" | "single" | "maybe" = "many";
  private countHead = false;

  constructor(
    private readonly db: FakeSupabase,
    private readonly name: string,
  ) {}

  select(cols = "*", options?: { count?: string; head?: boolean }): this {
    if (this.mode !== "select") this.returning = true;
    this.fields = parseSelect(cols.replace(/\s+/g, ""));
    if (options?.head) this.countHead = true;
    return this;
  }
  insert(rows: Row | Row[]): this {
    this.mode = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], options?: { onConflict?: string }): this {
    this.mode = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.upsertOn = options?.onConflict ?? "id";
    return this;
  }
  update(patch: Row): this {
    this.mode = "update";
    this.patch = patch;
    return this;
  }
  delete(): this {
    this.mode = "delete";
    return this;
  }
  private add(path: string, op: string, value: unknown): this {
    this.filters.push({ path, op, value });
    return this;
  }
  eq(path: string, value: unknown) {
    return this.add(path, "eq", value);
  }
  neq(path: string, value: unknown) {
    return this.add(path, "neq", value);
  }
  in(path: string, value: unknown[]) {
    return this.add(path, "in", value);
  }
  gte(path: string, value: unknown) {
    return this.add(path, "gte", value);
  }
  gt(path: string, value: unknown) {
    return this.add(path, "gt", value);
  }
  lte(path: string, value: unknown) {
    return this.add(path, "lte", value);
  }
  lt(path: string, value: unknown) {
    return this.add(path, "lt", value);
  }
  order(col: string, options?: { ascending?: boolean }): this {
    this.orders.push({ col, asc: options?.ascending ?? true });
    return this;
  }
  limit(n: number): this {
    this.rangeTo = this.rangeFrom + n - 1;
    return this;
  }
  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  single(): this {
    this.cardinality = "single";
    return this;
  }
  maybeSingle(): this {
    this.cardinality = "maybe";
    return this;
  }

  private value(row: Row, path: string): unknown {
    const json = /^([a-z_]+)->>([A-Za-z_]+)$/.exec(path);
    if (json) return (row[json[1]!] as Row | null)?.[json[2]!];
    const dot = path.split(".");
    if (dot.length === 2) {
      const rel = MANY_TO_ONE[this.name]?.[dot[0]!];
      if (!rel) throw new Error(`fake-supabase: unknown embedded filter ${path}`);
      return this.db.table(rel.table).find((p) => p.id === row[rel.fk])?.[dot[1]!];
    }
    return row[path];
  }

  private matching(): Row[] {
    return this.db
      .table(this.name)
      .filter((row) => this.filters.every((f) => test(this.value(row, f.path), f)));
  }

  private shape(rows: Row[]): Result {
    let out = rows
      .map((row) => this.db.embed(this.name, row, this.fields))
      .filter((r): r is Row => r !== null);
    for (const o of [...this.orders].reverse())
      out = [...out].sort((a, b) => (o.asc ? 1 : -1) * cmp(a[o.col], b[o.col]));
    const count = out.length;
    if (this.countHead) return { data: null, error: null, count };
    out = out.slice(this.rangeFrom, this.rangeTo + 1);
    if (this.cardinality === "many") return { data: out, error: null, count };
    if (out.length > 1)
      return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
    if (this.cardinality === "single" && out.length === 0)
      return { data: null, error: { code: "PGRST116", message: "no rows returned" } };
    return { data: out[0] ?? null, error: null };
  }

  private execute(): Result {
    // JSON round-trip mimics PostgREST serialisation (no shared object references).
    const clone = (r: Result): Result => ({
      ...r,
      data: r.data === undefined ? null : JSON.parse(JSON.stringify(r.data)),
    });
    switch (this.mode) {
      case "select":
        return clone(this.shape(this.matching()));
      case "insert":
      case "upsert": {
        const result = this.db.insertRows(
          this.name,
          this.payload,
          this.mode === "upsert" ? this.upsertOn : undefined,
        );
        if (result.error || !this.returning) return { data: null, error: result.error };
        return clone(this.shape(result.data as Row[]));
      }
      case "update": {
        const rows = this.matching();
        for (const row of rows) Object.assign(row, this.patch);
        return this.returning ? clone(this.shape(rows)) : { data: null, error: null };
      }
      case "delete": {
        const rows = this.matching();
        this.db.tables[this.name] = this.db.table(this.name).filter((r) => !rows.includes(r));
        return this.returning ? clone(this.shape(rows)) : { data: null, error: null };
      }
    }
  }

  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }
}

let shared: FakeSupabase | undefined;
/** The single in-memory database used by the simulated stack (NIGHTSHIFT_SIMULATION=true). */
export function simulatedDatabase(): FakeSupabase {
  return (shared ??= new FakeSupabase());
}
