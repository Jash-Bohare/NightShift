// Autonomous buyer loop (docs/05): plan → discover → verify on ENS → decide → quote → pay+run.
// Trusts only ENS (Sepolia) for price, payTo and endpoint; the directory is just a search hint.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  formatUsdc,
  nightshiftRegistrarAbi,
  REPUTATION_KEY,
  type BuyerEvent,
  type BuyerEventHandler,
  type BuyerRules,
} from "@nightshift/shared";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { parseBuffer } from "music-metadata";
import { createPublicClient, http, isAddressEqual, labelhash, zeroAddress } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { loadBuyerConfig, type BuyerConfig } from "./config.js";
import {
  filterRequirements,
  isValidPayTo,
  nameAllowed,
  parseEnsPrice,
  parseReputation,
  quoteMismatch,
  rankCandidates,
  type RankedAgent,
  type Rejection,
  type VerifiedAgent,
} from "./decide.js";
import { loadRules, loadState, recordSpend } from "./spending.js";

export interface BuyerTask {
  skill: string; // e.g. "transcribe:ta"
  file: string; // audio file to transcribe
  /** Billable minutes to declare; defaults to the measured duration rounded up. */
  units?: number;
}

export interface BuyerOptions {
  rules?: BuyerRules;
  onEvent?: BuyerEventHandler;
  config?: Partial<BuyerConfig>;
}

export interface BuyerRunResult {
  success: boolean;
  result?: string;
  jobId?: string;
  zgRequestId?: string;
  txId?: string;
  hashscanUrl?: string;
  chosenAgent?: string;
  error?: string;
}

interface DirectoryAgent {
  label: string;
  ensName: string;
  skill: string | null;
  price: { amount: string | null };
  reputation: { jobs: number; success: number; p50_ms: number } | null;
}

const MAX_VERIFY = 5;
const now = () => new Date().toISOString();

export function hashscanTxUrl(txId: string): string {
  // 0.0.9185802@1793885942.120229096 -> 0.0.9185802-1793885942-120229096
  return `https://hashscan.io/testnet/transaction/${txId.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`;
}

async function measureMinutes(buf: Buffer): Promise<number> {
  const meta = await parseBuffer(
    new Uint8Array(buf),
    { mimeType: "audio/mpeg", size: buf.length },
    {
      duration: true,
      skipCovers: true,
    },
  );
  const seconds = meta.format.duration;
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0)
    throw new Error("could not determine audio duration");
  return Math.max(1, Math.ceil(seconds / 60));
}

/** One sentence from 0G explaining the already-made choice. Falls back to a fixed sentence. */
async function rationale(
  chosen: RankedAgent,
  others: RankedAgent[],
  cfg: BuyerConfig,
): Promise<string> {
  const fallback = `Chose ${chosen.ensName}: cheapest verified agent at ${formatUsdc(chosen.totalAtomic)} USDC with ${Math.round(chosen.reputation.success * 100)}% success over ${chosen.reputation.jobs} job(s).`;
  const describe = (a: RankedAgent) =>
    `${a.ensName} costs ${formatUsdc(a.totalAtomic)} USDC, ${Math.round(a.reputation.success * 100)}% success over ${a.reputation.jobs} jobs`;
  const prompt = `You are "Podcast Assistant", an AI agent buying a Tamil transcription. Your rules already chose ${describe(chosen)}. Alternatives: ${others.map(describe).join("; ") || "none"}. In one short sentence, explain the choice.`;
  try {
    const res = await fetch(`${cfg.zgRouterUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.zgApiKey}` },
      body: JSON.stringify({
        model: cfg.zgChatModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 60,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() || fallback;
  } catch {
    return fallback;
  }
}

export async function runBuyer(
  task: BuyerTask,
  options: BuyerOptions = {},
): Promise<BuyerRunResult> {
  const emit = (e: BuyerEvent) => options.onEvent?.(e);
  const fail = (step: string, message: string): BuyerRunResult => {
    emit({ kind: "error", step, message, timestamp: now() });
    return { success: false, error: message };
  };

  let cfg: BuyerConfig;
  let rules: BuyerRules;
  try {
    cfg = loadBuyerConfig(options.config);
    rules = options.rules ?? loadRules();
  } catch (err) {
    return fail("plan", err instanceof Error ? err.message : String(err));
  }

  // 1. PLAN — measure the input so the declared units are honest.
  let fileBuf: Buffer;
  let units: number;
  try {
    fileBuf = readFileSync(resolve(task.file));
    const measured = await measureMinutes(fileBuf);
    if (task.units !== undefined && task.units < measured)
      return fail("plan", `declared ${task.units} minute(s) but the file is ${measured}`);
    units = task.units ?? measured;
  } catch (err) {
    return fail(
      "plan",
      `cannot read audio ${task.file}: ${err instanceof Error ? err.message : err}`,
    );
  }
  emit({
    kind: "plan",
    task: { skill: task.skill, file: basename(task.file), units },
    rules,
    timestamp: now(),
  });

  // 2. DISCOVER — the directory is a hint; everything is re-checked on ENS.
  let found: DirectoryAgent[];
  try {
    const maxPrice = BigInt(rules.maxPerJobAtomic) / BigInt(units);
    const url = `${cfg.serverUrl}/directory?skill=${encodeURIComponent(task.skill)}&maxPrice=${maxPrice}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    found = ((await res.json()) as { agents: DirectoryAgent[] }).agents;
  } catch (err) {
    return fail("discover", `directory query failed: ${err instanceof Error ? err.message : err}`);
  }
  emit({
    kind: "discover",
    candidates: found.map((a) => ({
      label: a.label,
      ensName: a.ensName,
      skill: a.skill ?? "",
      priceAtomic: a.price.amount ?? "0",
      reputation: a.reputation,
    })),
    timestamp: now(),
  });
  if (found.length === 0)
    return fail("discover", `no agents offer ${task.skill} within the per-job limit`);

  // 3. VERIFY on Sepolia: authentic resolver, then read every record the decision depends on.
  const client = createPublicClient({
    chain: sepolia,
    transport: http(cfg.sepoliaRpcUrl, { timeout: 20_000 }),
  });
  const verified: VerifiedAgent[] = [];
  for (const c of found.slice(0, MAX_VERIFY)) {
    const reject = (reason: string) =>
      emit({
        kind: "verify",
        label: c.label,
        ensName: c.ensName,
        ok: false,
        reason,
        timestamp: now(),
      });
    try {
      if (!nameAllowed(c.label, c.ensName, rules.allowParentNames)) {
        reject(`name ${c.ensName} is outside ${rules.allowParentNames.join(", ")}`);
        continue;
      }
      const name = normalize(c.ensName);
      const [registrarResolver, ensResolver] = await Promise.all([
        client.readContract({
          address: cfg.registrarAddress,
          abi: nightshiftRegistrarAbi,
          functionName: "resolverOf",
          args: [labelhash(c.label)],
        }),
        client.getEnsResolver({ name }),
      ]);
      if (registrarResolver === zeroAddress) {
        reject("not registered by NightshiftRegistrar");
        continue;
      }
      if (!isAddressEqual(ensResolver, registrarResolver)) {
        reject(`resolver ${ensResolver} is not the registrar's ${registrarResolver}`);
        continue;
      }
      const [skill, priceText, payTo, endpoint, repText] = await Promise.all(
        [
          "nightshift.skill",
          "nightshift.price",
          "nightshift.payto",
          "agent-endpoint[x402]",
          REPUTATION_KEY,
        ].map((key) => client.getEnsText({ name, key })),
      );
      const price = parseEnsPrice(priceText);
      const reputation = parseReputation(repText);
      if (skill !== task.skill) reject(`ENS skill ${skill ?? "missing"} != ${task.skill}`);
      else if (!price) reject("ENS nightshift.price missing or malformed");
      else if (!isValidPayTo(payTo)) reject("ENS nightshift.payto missing or not a Hedera account");
      else if (!endpoint || !URL.canParse(endpoint))
        reject("ENS agent-endpoint[x402] missing or invalid");
      else if (!reputation) reject("ENS nightshift.reputation missing or malformed");
      else {
        verified.push({
          label: c.label,
          ensName: c.ensName,
          skill,
          price,
          payTo,
          endpoint,
          reputation,
        });
        emit({
          kind: "verify",
          label: c.label,
          ensName: c.ensName,
          ok: true,
          resolver: ensResolver,
          payTo,
          timestamp: now(),
        });
      }
    } catch (err) {
      reject(`ENS read failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }
  if (verified.length === 0) return fail("verify", "no candidate passed ENS verification");

  // 4. DECIDE — deterministic ranking; failures during pay fall through to the next agent.
  const state = loadState();
  const daily = BigInt(rules.dailyBudgetAtomic);
  const spent = BigInt(state.dailySpentAtomic);
  const { queue, rejected } = rankCandidates(
    verified,
    units,
    rules,
    daily > spent ? daily - spent : 0n,
  );
  const skipped: Rejection[] = [...rejected];
  if (queue.length === 0)
    return fail(
      "decide",
      `every candidate broke a spending rule: ${skipped.map((r) => `${r.label} (${r.reason})`).join("; ")}`,
    );

  const signer = createClientHederaSigner(
    cfg.buyerAccountId,
    PrivateKey.fromStringECDSA(cfg.buyerPrivateKey),
    {
      network: "hedera:testnet",
    },
  );

  for (const [i, chosen] of queue.entries()) {
    emit({
      kind: "decide",
      chosen: {
        label: chosen.label,
        ensName: chosen.ensName,
        priceAtomic: chosen.price.amount.toString(),
        payTo: chosen.payTo,
      },
      rationale: await rationale(chosen, queue.slice(i + 1), cfg),
      rejected: [...skipped],
      timestamp: now(),
    });

    // 5. QUOTE — must equal ENS price × units and pay the ENS payTo.
    const origin = new URL(chosen.endpoint).origin;
    try {
      const res = await fetch(`${origin}/a/${chosen.label}/quote?units=${units}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const q = (await res.json()) as {
        amount: string;
        asset: string;
        network: string;
        payTo: string;
      };
      const mismatch = quoteMismatch(q, chosen);
      if (mismatch) throw new Error(mismatch);
      emit({
        kind: "quote",
        label: chosen.label,
        units,
        amount: q.amount,
        asset: q.asset,
        payTo: q.payTo,
        timestamp: now(),
      });
    } catch (err) {
      const reason = `quote rejected: ${err instanceof Error ? err.message : err}`;
      emit({ kind: "payment_failed", label: chosen.label, error: reason, timestamp: now() });
      skipped.push({ label: chosen.label, reason });
      continue;
    }

    // 6. PAY + RUN — x402 client signs only a transfer of exactly that amount to the ENS payTo.
    const expected = {
      payTo: chosen.payTo,
      asset: chosen.price.asset,
      network: chosen.price.network,
      amount: chosen.totalAtomic,
    };
    const x402 = new x402Client()
      .register("hedera:testnet", new ExactHederaScheme(signer))
      .setSpendControls({
        allowedAssets: rules.allowedNetworks.flatMap((network) =>
          rules.allowedAssets.map((asset) => ({
            network: network as `${string}:${string}`,
            asset,
            maxAmountPerPayment: rules.maxPerJobAtomic,
          })),
        ),
      })
      .registerPolicy((_v, reqs) => filterRequirements(reqs, expected, rules));
    const payFetch = wrapFetchWithPayment(fetch, x402);

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(fileBuf)], { type: "audio/mpeg" }),
      basename(task.file),
    );
    const t0 = performance.now();
    try {
      const res = await payFetch(chosen.endpoint, {
        method: "POST",
        headers: { "X-Nightshift-Units": String(units) },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
      const body = await res.text();
      if (res.status === 503) {
        const reason = (() => {
          try {
            const j = JSON.parse(body) as { error?: string; message?: string };
            return `${j.error ?? "unavailable"}: ${j.message ?? ""}`.trim();
          } catch {
            return "service unavailable";
          }
        })();
        emit({ kind: "refused", label: chosen.label, status: 503, reason, timestamp: now() });
        skipped.push({ label: chosen.label, reason: `refused (${reason.split(":")[0]})` });
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);

      const header = res.headers.get("PAYMENT-RESPONSE");
      if (!header) throw new Error("server returned 200 without a settled payment");
      const settle = decodePaymentResponseHeader(header);
      if (!settle.success) throw new Error("payment did not settle");
      const hashscanUrl = hashscanTxUrl(settle.transaction);
      recordSpend(chosen.totalAtomic);
      emit({
        kind: "paid",
        label: chosen.label,
        txId: settle.transaction,
        hashscanUrl,
        amount: chosen.totalAtomic.toString(),
        timestamp: now(),
      });

      const out = JSON.parse(body) as {
        job_id?: string;
        output?: string;
        zg?: { request_id?: string };
      };
      const jobId = out.job_id ?? res.headers.get("X-Nightshift-Job") ?? undefined;
      const zgRequestId = out.zg?.request_id;
      emit({
        kind: "result",
        label: chosen.label,
        text: out.output ?? "",
        ...(jobId ? { jobId } : {}),
        ...(zgRequestId ? { zgRequestId } : {}),
        latencyMs: Math.round(performance.now() - t0),
        timestamp: now(),
      });
      return {
        success: true,
        result: out.output ?? "",
        ...(jobId ? { jobId } : {}),
        ...(zgRequestId ? { zgRequestId } : {}),
        txId: settle.transaction,
        hashscanUrl,
        chosenAgent: chosen.ensName,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      emit({ kind: "payment_failed", label: chosen.label, error: reason, timestamp: now() });
      skipped.push({ label: chosen.label, reason: "payment or run failed" });
    }
  }
  return fail(
    "pay",
    `all ${queue.length} candidate(s) refused or failed: ${skipped.map((r) => `${r.label} (${r.reason})`).join("; ")}`,
  );
}
