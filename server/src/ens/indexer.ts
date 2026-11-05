// ENS Indexer: reads AgentRegistered & ReputationUpdated events from NightshiftRegistrar,
// verifies resolver authenticity against registrar.resolverOf(labelhash), reads ENS records via viem,
// and upserts the directory cache in Supabase. Checkpoint is persisted in indexer_state.

import { ENS_PARENT_NAME, nightshiftRegistrarAbi } from "@nightshift/shared";
import { createPublicClient, http, isAddressEqual, labelhash, zeroAddress, type Address } from "viem";
import { sepolia } from "viem/chains";
import { deployment } from "../config.js";
import { db } from "../db/client.js";
import { log, logError } from "../log.js";
import { readAgentRecords } from "./read.js";
import { sepoliaClient } from "./registrar.js";

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http("https://ethereum-sepolia-rpc.publicnode.com", { timeout: 15_000 }),
});

const registrar = {
  address: deployment.nightshiftRegistrar as Address,
  abi: nightshiftRegistrarAbi,
} as const;

export interface IndexerResult {
  indexed: number;
  fromBlock: bigint;
  toBlock: bigint;
  labels: string[];
}

export async function getLastIndexedBlock(): Promise<bigint> {
  const r = await db.from("indexer_state").select("last_block").eq("id", "sepolia").maybeSingle();
  if (r.data?.last_block) {
    return BigInt(r.data.last_block);
  }
  return 12068000n; // block before tamil-scribe (12068986)
}

export async function setLastIndexedBlock(block: bigint): Promise<void> {
  await db.from("indexer_state").upsert(
    {
      id: "sepolia",
      last_block: Number(block),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

/** Sync a single agent by label from on-chain state to the directory table. */
export async function syncAgentToDirectory(label: string, currentBlock?: bigint): Promise<boolean> {
  try {
    const lhash = labelhash(label);
    const [onchainResolver, onchainOwner] = await Promise.all([
      sepoliaClient.readContract({ ...registrar, functionName: "resolverOf", args: [lhash] }),
      sepoliaClient.readContract({ ...registrar, functionName: "ownerOf", args: [lhash] }),
    ]);

    if (!onchainResolver || onchainResolver === zeroAddress) {
      log("ens", `agent ${label} not found on registrar resolverOf`);
      return false;
    }

    const ensName = `${label}.${ENS_PARENT_NAME}`;
    const recs = await readAgentRecords(ensName);

    if (
      !recs.resolver ||
      !isAddressEqual(recs.resolver as Address, onchainResolver as Address)
    ) {
      logError(
        "ens",
        `resolver mismatch for ${ensName}: on-chain ${onchainResolver} vs resolved ${recs.resolver}`,
      );
      return false;
    }

    // Parse price
    let priceAtomic: string = "0";
    let priceUnit: string = "minute";
    const priceText = recs.texts["nightshift.price"];
    if (priceText) {
      try {
        const parsed = JSON.parse(priceText);
        if (parsed.amount) priceAtomic = String(parsed.amount);
        if (parsed.unit) priceUnit = String(parsed.unit);
      } catch {
        if (/^\d+$/.test(priceText)) priceAtomic = priceText;
      }
    }

    // Parse reputation
    let reputation: any = null;
    const repText = recs.texts["nightshift.reputation"];
    if (repText) {
      try {
        reputation = JSON.parse(repText);
      } catch {
        reputation = { raw: repText };
      }
    }

    const row = {
      label,
      ens_name: ensName,
      owner: onchainOwner,
      resolver: onchainResolver,
      skill: recs.texts["nightshift.skill"] ?? null,
      price_atomic: priceAtomic ? BigInt(priceAtomic).toString() : null,
      price_unit: priceUnit,
      payto: recs.texts["nightshift.payto"] ?? null,
      endpoint: recs.texts["agent-endpoint[x402]"] ?? null,
      model: recs.texts["nightshift.model"] ?? null,
      description: recs.texts["description"] ?? null,
      reputation,
      status: "active",
      last_block: currentBlock ? Number(currentBlock) : undefined,
      updated_at: new Date().toISOString(),
    };

    const up = await db.from("directory").upsert(row, { onConflict: "label" });
    if (up.error) {
      logError("db", `directory upsert failed for ${label}: ${up.error.message}`);
      return false;
    }

    log("ens", `indexed ${ensName} into directory`, {
      skill: row.skill,
      price: row.price_atomic,
      payTo: row.payto,
    });
    return true;
  } catch (err) {
    logError("ens", `syncAgentToDirectory failed for ${label}`, err);
    return false;
  }
}

/**
 * Main indexer run: scans recent blocks for registrar events, verifies agents on Sepolia,
 * and updates directory in Supabase.
 */
export async function runIndexer(): Promise<IndexerResult> {
  const fromBlock = await getLastIndexedBlock();
  let toBlock = fromBlock;
  const labelsToSync = new Set<string>();

  try {
    const currentBlock = await sepoliaClient.getBlockNumber();
    toBlock = currentBlock;

    // Scan for AgentRegistered events in safe block slices if fromBlock < toBlock
    if (fromBlock <= toBlock) {
      // Search window up to 2000 blocks with public client fallback
      const scanFrom = fromBlock > toBlock - 2000n ? fromBlock : toBlock - 2000n;
      try {
        const clientToUse = publicClient || sepoliaClient;
        const regLogs = await clientToUse.getContractEvents({
          address: registrar.address,
          abi: nightshiftRegistrarAbi,
          eventName: "AgentRegistered",
          fromBlock: scanFrom,
          toBlock,
        });
        for (const logItem of regLogs) {
          if (logItem.args.label) {
            labelsToSync.add(logItem.args.label);
          }
        }
      } catch (err) {
        logError("ens", `getContractEvents AgentRegistered failed (using db fallback)`, err);
      }

      try {
        const repLogs = await sepoliaClient.getContractEvents({
          address: registrar.address,
          abi: nightshiftRegistrarAbi,
          eventName: "ReputationUpdated",
          fromBlock: scanFrom,
          toBlock,
        });
        // For reputation logs, labelhash is indexed. We can sync all active agents if any rep updated.
        if (repLogs.length > 0) {
          const allActive = await db.from("agents").select("label").neq("status", "failed");
          for (const a of allActive.data ?? []) {
            labelsToSync.add(a.label);
          }
        }
      } catch {
        // Reputation log scan failure is non-fatal
      }
    }

    // Always include any active/registered agents from local database to ensure directory stays fresh
    const activeAgents = await db
      .from("agents")
      .select("label")
      .in("status", ["active", "paused_owner", "paused_budget"]);
    for (const a of activeAgents.data ?? []) {
      labelsToSync.add(a.label);
    }

    // Also include any directory entries older than 5 minutes to refresh reputation/prices
    const staleDir = await db
      .from("directory")
      .select("label")
      .lt("updated_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());
    for (const s of staleDir.data ?? []) {
      labelsToSync.add(s.label);
    }

    let indexedCount = 0;
    const syncedLabels: string[] = [];
    for (const label of labelsToSync) {
      const ok = await syncAgentToDirectory(label, currentBlock);
      if (ok) {
        indexedCount++;
        syncedLabels.push(label);
      }
    }

    await setLastIndexedBlock(toBlock);
    return {
      indexed: indexedCount,
      fromBlock,
      toBlock,
      labels: syncedLabels,
    };
  } catch (err) {
    logError("ens", "runIndexer failed", err);
    return {
      indexed: 0,
      fromBlock,
      toBlock,
      labels: [],
    };
  }
}
