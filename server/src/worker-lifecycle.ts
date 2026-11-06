import type { AgentRow } from "./db/types.js";
import { ApiError } from "./errors.js";

export interface WorkerRegistryReader {
  status(label: string): Promise<number>;
  expiry(label: string): Promise<bigint>;
}

export async function assertWorkerRunnable(
  agent: AgentRow,
  reader: WorkerRegistryReader,
  nowSeconds = BigInt(Math.floor(Date.now() / 1000)),
): Promise<void> {
  if (agent.status !== "active" && agent.status !== "paused_budget")
    throw new ApiError(409, "agent_paused", `agent is ${agent.status}`);
  if (!agent.expiry || !Number.isFinite(Date.parse(agent.expiry)))
    throw new ApiError(503, "zg_unavailable", "worker registration expiry is unavailable");
  if (Date.parse(agent.expiry) <= Number(nowSeconds) * 1000)
    throw new ApiError(409, "agent_paused", "worker registration has expired");
  const [status, expiry] = await Promise.all([
    reader.status(agent.label),
    reader.expiry(agent.label),
  ]);
  if (status !== 2) throw new ApiError(409, "agent_paused", "worker is not registered on Sepolia");
  if (expiry <= nowSeconds)
    throw new ApiError(409, "agent_paused", "worker registration has expired on Sepolia");
}
