// ENS indexer (every 30 s): keeps the `directory` cache in sync with the chain.
// Sources: NightshiftRegistrar events (AgentRegistered, ReputationUpdated, AgentRenewed, AgentRevoked)
// scanned from a persisted checkpoint, plus a 5-minute refresh that picks up owner record edits.
// Records always come from ENS (the source of truth); status comes from our `agents` table.
import { ENS_PARENT_NAME, nightshiftRegistrarAbi } from "@nightshift/shared";
import {
  createPublicClient,
  http,
  isAddressEqual,
  labelhash,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { deployment, env } from "../config.js";
import { db } from "../db/client.js";
import type { AgentStatus } from "../db/types.js";
import { UpstreamError } from "../errors.js";
import { log, logError } from "../log.js";
import { readAgentRecords } from "./read.js";
import { sepoliaClient } from "./registrar.js";

const CHECKPOINT_ID = "sepolia";
const CHUNK_BLOCKS = 2_000n;
const CONFIRMATIONS = 2n;
const MAX_GAP = 50_000n;
const STALE_MS = 5 * 60_000;

const logsClient = createPublicClient({
  chain: sepolia,
  transport: http(env.SEPOLIA_LOGS_RPC_URL ?? env.SEPOLIA_RPC_URL, { timeout: 20_000 }),
});

const registrar = {
  address: deployment.nightshiftRegistrar as Address,
  abi: nightshiftRegistrarAbi,
} as const;

/** Directory status for an agent our server does not manage (registered elsewhere, not runnable here). */
export const UNMANAGED = "unmanaged";
export type DirectoryStatus = AgentStatus | typeof UNMANAGED;

export interface IndexerResult {
  indexed: string[];
  failed: string[];
  fromBlock: bigint;
  toBlock: bigint;
}

async function getCheckpoint(): Promise<bigint> {
  const r = await db
    .from("indexer_state")
    .select("last_block")
    .eq("id", CHECKPOINT_ID)
    .maybeSingle();
  if (r.error) throw new UpstreamError("db", `indexer_state: ${r.error.message}`);
  const last = (r.data as { last_block: number | string } | null)?.last_block;
  return last !== undefined ? BigInt(last) : BigInt(deployment.deployBlock) - 1n;
}

async function setCheckpoint(block: bigint): Promise<void> {
  const r = await db.from("indexer_state").upsert({
    id: CHECKPOINT_ID,
    last_block: block.toString(),
    updated_at: new Date().toISOString(),
  });
  if (r.error) throw new UpstreamError("db", `indexer_state: ${r.error.message}`);
}

/** price JSON -> {amount, unit}; null fields when the record is missing or malformed. */
function parsePrice(text: string | undefined): { amount: string | null; unit: string | null } {
  try {
    const j = JSON.parse(text ?? "") as { amount?: unknown; unit?: unknown };
    return {
      amount: typeof j.amount === "string" && /^\d+$/.test(j.amount) ? j.amount : null,
      unit: typeof j.unit === "string" ? j.unit : null,
    };
  } catch {
    return { amount: null, unit: null };
  }
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  try {
    const j: unknown = JSON.parse(text ?? "");
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Re-read one agent from chain + ENS and upsert its directory row. Throws on any read failure so a
 * partial row is never written. A label the registrar does not know is removed from the directory.
 */
export async function syncAgentToDirectory(label: string): Promise<"indexed" | "removed"> {
  const lh = labelhash(label);
  const [resolver, owner] = await Promise.all([
    sepoliaClient.readContract({ ...registrar, functionName: "resolverOf", args: [lh] }),
    sepoliaClient.readContract({ ...registrar, functionName: "ownerOf", args: [lh] }),
  ]);
  if (resolver === zeroAddress) {
    await db.from("directory").delete().eq("label", label);
    return "removed";
  }
  const ensName = `${label}.${ENS_PARENT_NAME}`;
  const recs = await readAgentRecords(ensName, true);
  if (!recs.resolver || !isAddressEqual(recs.resolver as Address, resolver))
    throw new UpstreamError(
      "ens",
      `${ensName} resolves via ${recs.resolver}, registrar says ${resolver}`,
    );

  const agent = await db.from("agents").select("status,expiry").eq("label", label).maybeSingle();
  if (agent.error) throw new UpstreamError("db", `agent ${label}: ${agent.error.message}`);
  const row = agent.data as { status: AgentStatus; expiry: string | null } | null;

  const price = parsePrice(recs.texts["nightshift.price"]);
  const up = await db.from("directory").upsert({
    label,
    ens_name: ensName,
    owner,
    resolver,
    skill: recs.texts["nightshift.skill"] ?? null,
    price_atomic: price.amount,
    price_unit: price.unit,
    payto: recs.texts["nightshift.payto"] ?? null,
    endpoint: recs.texts["agent-endpoint[x402]"] ?? null,
    model: recs.texts["nightshift.model"] ?? null,
    description: recs.texts["description"] ?? null,
    reputation: parseJson(recs.texts["nightshift.reputation"]),
    expiry: row?.expiry ?? null,
    status: (row?.status ?? UNMANAGED) satisfies DirectoryStatus,
    updated_at: new Date().toISOString(),
  });
  if (up.error) throw new UpstreamError("db", `directory upsert ${label}: ${up.error.message}`);
  return "indexed";
}

/** Labels touched by registrar events in (from, to]; reputation/renew/revoke events are keyed by labelhash. */
export async function labelsFromEvents(
  from: bigint,
  to: bigint,
  known: Map<Hex, string>,
): Promise<Set<string>> {
  const labels = new Set<string>();
  for (let start = from + 1n; start <= to; start += CHUNK_BLOCKS) {
    const end = start + CHUNK_BLOCKS - 1n < to ? start + CHUNK_BLOCKS - 1n : to;
    const logs = await logsClient.getContractEvents({
      ...registrar,
      fromBlock: start,
      toBlock: end,
    });
    for (const l of logs) {
      if (l.eventName === "AgentRegistered") {
        if (l.args.label) labels.add(l.args.label);
      } else if (
        l.eventName === "ReputationUpdated" ||
        l.eventName === "AgentRenewed" ||
        l.eventName === "AgentRevoked"
      ) {
        const label = l.args.labelhash ? known.get(l.args.labelhash) : undefined;
        if (label) labels.add(label);
      }
    }
  }
  return labels;
}

export async function runIndexer(): Promise<IndexerResult> {
  const fromBlock = await getCheckpoint();
  // Head from the same node that serves the logs (RPC heads differ), minus a small reorg margin.
  const toBlock = (await logsClient.getBlockNumber()) - CONFIRMATIONS;

  const [agents, dir] = await Promise.all([
    db.from("agents").select("label").neq("status", "failed"),
    db.from("directory").select("label,updated_at"),
  ]);
  if (agents.error) throw new UpstreamError("db", agents.error.message);
  if (dir.error) throw new UpstreamError("db", dir.error.message);
  const dirRows = dir.data as { label: string; updated_at: string }[];
  const known = new Map<Hex, string>();
  for (const { label } of [...(agents.data as { label: string }[]), ...dirRows])
    known.set(labelhash(label), label);

  // A checkpoint far behind (server down for days) would hit pruned history on public RPCs:
  // scan at most MAX_GAP blocks. Agents we manage are covered by the missing/stale rules below.
  const scanFrom = toBlock - fromBlock > MAX_GAP ? toBlock - MAX_GAP : fromBlock;
  let todo = new Set<string>();
  let scanned = false;
  if (toBlock > scanFrom) {
    try {
      todo = await labelsFromEvents(scanFrom, toBlock, known);
      scanned = true;
    } catch (err) {
      logError("ens", `event scan ${scanFrom}-${toBlock} failed (checkpoint kept)`, err);
    }
  }
  const inDirectory = new Set(dirRows.map((r) => r.label));
  for (const { label } of agents.data as { label: string }[])
    if (!inDirectory.has(label)) todo.add(label);
  const staleBefore = Date.now() - STALE_MS;
  for (const r of dirRows) if (Date.parse(r.updated_at) < staleBefore) todo.add(r.label);

  const indexed: string[] = [];
  const failed: string[] = [];
  for (const label of todo) {
    try {
      await syncAgentToDirectory(label);
      indexed.push(label);
    } catch (err) {
      failed.push(label);
      logError("ens", `index ${label} failed (retried next run)`, err);
    }
  }
  // Advance only after a full event scan; failed labels are retried via the missing/stale rules.
  if (scanned) await setCheckpoint(toBlock);
  if (indexed.length || failed.length)
    log("ens", "indexer run", { indexed, failed, toBlock: toBlock.toString() });
  return { indexed, failed, fromBlock, toBlock };
}
