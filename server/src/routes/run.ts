// /a/:label/run — runPrecheck (before x402) and runHandler (after x402 verify, before settle).
import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { big } from "../db/client.js";
import { agentByLabel, agentZgKey, insertJob, setAgentStatus, updateJob } from "../db/queries.js";
import type { AgentRow } from "../db/types.js";
import { ApiError, UpstreamError } from "../errors.js";
import { log, logError } from "../log.js";
import { parseDeclaredUnits, priceFor } from "../pricing.js";
import { getSkill, type Skill, type SkillInput } from "../skills/index.js";
import { MAX_AUDIO_BYTES } from "../skills/audio.js";
import { JOB_HEADER } from "../x402/server.js";
import { reservations, canRun } from "../zg/budget.js";

/** Stashed by runPrecheck for runHandler. */
export interface RunContext {
  agent: AgentRow;
  skill: Skill;
  input: SkillInput;
  units: number;
  priceAtomic: bigint;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      nightshift?: RunContext;
    }
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
}).single("file");

function parseMultipart(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) =>
    upload(req, res, (err: unknown) => {
      if (!err) return resolve();
      const msg = err instanceof Error ? err.message : String(err);
      reject(new ApiError(422, "invalid_input", `upload rejected: ${msg}`));
    }),
  );
}

const RUNNABLE = new Set(["active", "paused_budget"]);

async function precheck(req: Request, res: Response): Promise<RunContext> {
  const label = String(req.params.label);
  const agent = await agentByLabel(label);
  if (!agent || !agent.hedera_account_id) throw new ApiError(404, "not_found", `no agent ${label}`);
  if (!RUNNABLE.has(agent.status))
    throw new ApiError(409, "agent_paused", `agent is ${agent.status}`);
  const skill = getSkill(agent.skill);
  if (!skill) throw new ApiError(500, "internal", `agent has unknown skill ${agent.skill}`);

  const declared = parseDeclaredUnits(req.header("x-nightshift-units"));
  if (declared === null)
    throw new ApiError(
      422,
      "invalid_input",
      "header X-Nightshift-Units is required (a positive number)",
    );

  await parseMultipart(req, res);
  const file = req.file;
  if (!file) throw new ApiError(422, "invalid_input", "multipart field `file` is required");
  const input: SkillInput = {
    kind: "audio",
    buf: file.buffer,
    mime: file.mimetype,
    filename: file.originalname || "audio",
  };

  let measured;
  try {
    measured = await skill.measure(input);
  } catch (err) {
    throw new ApiError(
      422,
      "invalid_input",
      err instanceof Error ? err.message : "unreadable input",
    );
  }
  if (measured.units > declared)
    throw new ApiError(
      422,
      "units_mismatch",
      `input is ${measured.units} ${skill.unit}(s), declared ${declared}`,
      {
        actual: measured.units,
        declared,
      },
    );

  const priceAtomic = priceFor(big(agent.price_atomic), declared);
  const budget = await canRun(agent, measured.meterUnits);
  if (!budget.ok) {
    await insertJob({
      agent_id: agent.id,
      status: "refused_budget",
      units: declared,
      price_atomic: "0",
      error: budget.reason,
    });
    if (budget.reason === "over_budget") {
      if (agent.status !== "paused_budget") await setAgentStatus(agent, "paused_budget");
      throw new ApiError(503, "over_budget", "agent's daily 0G budget is used up", {
        resetsAt: budget.resetsAt.toISOString(),
      });
    }
    throw new ApiError(503, "no_credits", "agent's 0G account has no credits left");
  }
  // Lazy un-pause: a new UTC day (or a smaller job) fits the cap again.
  if (agent.status === "paused_budget") await setAgentStatus(agent, "active");

  // Only a paid attempt reserves budget, released when the response closes.
  if (req.header("payment-signature")) {
    const release = reservations.hold(agent.id, budget.estimateUsdMicro);
    res.on("close", release);
  }
  return { agent, skill, input, units: declared, priceAtomic };
}

/** Runs before the x402 middleware: rejects requests nobody should pay for. */
export const runPrecheck: RequestHandler = async (req, res, next: NextFunction) => {
  try {
    req.nightshift = await precheck(req, res);
    next();
  } catch (err) {
    next(err);
  }
};

/** Runs after x402 verify. A status >= 400 cancels settlement, so the buyer is not charged. */
export const runHandler: RequestHandler = async (req, res) => {
  const ctx = req.nightshift;
  if (!ctx) throw new ApiError(500, "internal", "precheck context missing");
  const { agent, skill, input, units, priceAtomic } = ctx;

  const jobId = await insertJob({
    agent_id: agent.id,
    status: "running",
    units,
    price_atomic: priceAtomic.toString(),
  });
  res.setHeader(JOB_HEADER, jobId);
  const t0 = performance.now();
  try {
    const key = await agentZgKey(agent.id);
    const out = await skill.execute({ key, model: agent.model, input });
    const latency = Math.round(performance.now() - t0);
    await updateJob(jobId, {
      status: "done",
      zg_request_id: out.requestId,
      zg_provider: out.provider,
      zg_cost_usd_micro: out.costUsdMicro.toString(),
      latency_ms: latency,
    });
    log("server", "job done", { job: jobId, agent: agent.label, ms: latency });
    res.json({
      job_id: jobId,
      output: out.output,
      zg: { request_id: out.requestId, provider: out.provider },
    });
  } catch (err) {
    const upstream = err instanceof UpstreamError && err.upstream === "0g";
    logError(upstream ? "0g" : "server", `job ${jobId} failed`, err);
    await updateJob(jobId, {
      status: upstream ? "failed_upstream" : "failed_internal",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      latency_ms: Math.round(performance.now() - t0),
    }).catch((e: unknown) => logError("db", `job ${jobId} failure update`, e));
    if (upstream)
      res.status(502).json({
        error: "zg_unavailable",
        message: "0G inference failed; you were not charged",
        job_id: jobId,
      });
    else
      res
        .status(500)
        .json({ error: "internal", message: "job failed; you were not charged", job_id: jobId });
  }
};
