// Autonomous Buyer Agent Loop (docs/05-buyer-agent.md).
// Discovers, verifies on-chain, scores candidates, queries 0G for rationale,
// enforces spending rules & payTo policies, executes x402 payment on Hedera,
// and handles fallback on refusal.

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createClientHederaSigner, HEDERA_TESTNET_USDC, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import {
  ENS_PARENT_NAME,
  nightshiftRegistrarAbi,
  type BuyerEvent,
  type BuyerEventHandler,
  type BuyerRules,
} from "@nightshift/shared";
import { parseBuffer } from "music-metadata";
import { createPublicClient, http, isAddressEqual, labelhash, zeroAddress, type Address } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { loadRules, recordSpend, validateSpend } from "./spending.js";

export interface BuyerTask {
  skill: string; // e.g. "transcribe:ta"
  file?: string; // path to sample audio file
  description?: string;
  maxUnits?: number;
}

export interface BuyerOptions {
  rules?: BuyerRules;
  onEvent?: BuyerEventHandler;
  serverUrl?: string;
  buyerAccountId?: string;
  buyerPrivateKey?: string;
  sepoliaRpcUrl?: string;
  zgRouterUrl?: string;
  zgApiKey?: string;
  zgChatModel?: string;
  registrarAddress?: string;
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

function txIdForUrl(txId: string): string {
  return txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
}

function getEnv(name: string, fallback?: string): string {
  return process.env[name] ?? fallback ?? "";
}

/** Audio duration to billable minutes (rounded up, min 1) */
function audioMinutes(seconds: number): number {
  if (seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / 60));
}

/** Calls 0G Compute Router chat model to generate a one-sentence rationale */
async function generateLlmRationale(
  chosen: { label: string; ensName: string; priceAtomic: string; reputation: any },
  competitors: Array<{ label: string; priceAtomic: string; reputation: any }>,
  options: { zgRouterUrl: string; zgApiKey: string; zgChatModel: string },
): Promise<string> {
  if (!options.zgApiKey) {
    return `Selected ${chosen.ensName} ($${(Number(chosen.priceAtomic) / 1e6).toFixed(2)}/min) based on verified on-chain reputation and best pricing.`;
  }

  const prompt = `You are the AI buyer agent Podcast Assistant. You selected ${chosen.ensName} (price: ${chosen.priceAtomic} atomic, reputation: ${chosen.reputation?.success ?? 0}/${chosen.reputation?.jobs ?? 0} successful jobs) over competitors: ${competitors.map((c) => `${c.label} (${c.priceAtomic} atomic)`).join(", ")}. In one concise sentence, explain why you chose this agent.`;

  try {
    const res = await fetch(`${options.zgRouterUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.zgApiKey}`,
      },
      body: JSON.stringify({
        model: options.zgChatModel || "qwen-flash",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 60,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    }
  } catch {
    // LLM call failure is non-fatal; fall through to deterministic sentence
  }

  return `Selected ${chosen.ensName} ($${(Number(chosen.priceAtomic) / 1e6).toFixed(2)}/min) providing the lowest price with on-chain verified identity and reputation.`;
}

/** Core autonomous buyer loop (docs/05-buyer-agent.md) */
export async function runBuyer(task: BuyerTask, options: BuyerOptions = {}): Promise<BuyerRunResult> {
  const rules = options.rules ?? loadRules();
  const emit = (event: BuyerEvent) => {
    if (options.onEvent) options.onEvent(event);
  };

  const serverUrl = options.serverUrl || getEnv("BUYER_SERVER_URL", "http://localhost:8787");
  const buyerId = options.buyerAccountId || getEnv("BUYER_HEDERA_ACCOUNT_ID");
  const buyerKey = options.buyerPrivateKey || getEnv("BUYER_HEDERA_PRIVATE_KEY");
  const rpcUrl = options.sepoliaRpcUrl || getEnv("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com");
  const zgRouter = options.zgRouterUrl || getEnv("ZG_ROUTER_URL", "https://router-api.0g.ai/v1");
  const zgKey = options.zgApiKey || getEnv("BUYER_ZG_SK_KEY") || getEnv("ZG_TEAM_SK_KEY");
  const zgModel = options.zgChatModel || getEnv("ZG_CHAT_MODEL", "qwen-flash");
  const registrarAddress = (options.registrarAddress ||
    getEnv("NIGHTSHIFT_REGISTRAR_ADDRESS") ||
    "0x9564fFd96FBaA1bF10836966990aCc88a9865705") as Address;

  // 1. PLAN
  emit({
    kind: "plan",
    task,
    rules,
    timestamp: new Date().toISOString(),
  });

  // Calculate units from file if available
  let declaredUnits = task.maxUnits ?? 1;
  let fileBuffer: Buffer | null = null;
  let fileName = "input.mp3";
  let fileMime = "audio/mpeg";

  if (task.file) {
    const fullPath = resolve(task.file);
    if (!existsSync(fullPath)) {
      const err = `Task file not found at ${fullPath}`;
      emit({ kind: "error", message: err, step: "plan", timestamp: new Date().toISOString() });
      return { success: false, error: err };
    }
    fileBuffer = readFileSync(fullPath);
    fileName = basename(fullPath);
    try {
      const meta = await parseBuffer(fileBuffer, fileMime);
      if (meta.format.duration) {
        declaredUnits = audioMinutes(meta.format.duration);
      }
    } catch {
      declaredUnits = 2; // default 90s clip = 2 min
    }
  }

  // 2. DISCOVER
  const maxPricePerUnit = (BigInt(rules.maxPerJobAtomic) / BigInt(declaredUnits)).toString();
  const dirUrl = `${serverUrl}/directory?skill=${encodeURIComponent(task.skill)}&maxPrice=${maxPricePerUnit}&status=active`;

  let candidates: any[] = [];
  try {
    const dirRes = await fetch(dirUrl, { signal: AbortSignal.timeout(10_000) });
    if (!dirRes.ok) throw new Error(`Directory query failed: ${dirRes.status}`);
    const dirData = (await dirRes.json()) as any;
    candidates = dirData.data?.agents ?? dirData.agents ?? [];
  } catch (err) {
    const msg = `Failed to discover agents: ${err instanceof Error ? err.message : err}`;
    emit({ kind: "error", message: msg, step: "discover", timestamp: new Date().toISOString() });
    return { success: false, error: msg };
  }

  emit({
    kind: "discover",
    candidates: candidates.map((c) => ({
      label: c.label,
      ensName: c.ensName,
      skill: c.skill,
      priceAtomic: c.priceAtomic ?? c.price?.amount ?? "0",
      reputation: c.reputation,
    })),
    timestamp: new Date().toISOString(),
  });

  if (candidates.length === 0) {
    const msg = `No available agents found for skill ${task.skill} within budget limit`;
    emit({ kind: "error", message: msg, step: "discover", timestamp: new Date().toISOString() });
    return { success: false, error: msg };
  }

  // 3. VERIFY ON SEPOLIA (max 5 candidates)
  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl, { timeout: 20_000 }),
  });

  const verifiedCandidates: Array<{
    label: string;
    ensName: string;
    skill: string;
    priceAtomic: string;
    payTo: string;
    endpoint: string;
    reputation: any;
  }> = [];

  for (const c of candidates.slice(0, 5)) {
    try {
      const lhash = labelhash(c.label);
      const onchainResolver = await client.readContract({
        address: registrarAddress,
        abi: nightshiftRegistrarAbi,
        functionName: "resolverOf",
        args: [lhash],
      });

      if (!onchainResolver || onchainResolver === zeroAddress) {
        emit({
          kind: "verify",
          label: c.label,
          ensName: c.ensName,
          ok: false,
          reason: "Not registered on NightshiftRegistrar",
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // Read live ENS records
      const normName = normalize(c.ensName);
      const [resolvedResolver, endpoint, payTo, priceText, repText] = await Promise.all([
        client.getEnsResolver({ name: normName }).catch(() => null),
        client.getEnsText({ name: normName, key: "agent-endpoint[x402]" }).catch(() => null),
        client.getEnsText({ name: normName, key: "nightshift.payto" }).catch(() => null),
        client.getEnsText({ name: normName, key: "nightshift.price" }).catch(() => null),
        client.getEnsText({ name: normName, key: "nightshift.reputation" }).catch(() => null),
      ]);

      if (!resolvedResolver || !isAddressEqual(resolvedResolver as Address, onchainResolver as Address)) {
        emit({
          kind: "verify",
          label: c.label,
          ensName: c.ensName,
          ok: false,
          reason: `Resolver mismatch: registrar=${onchainResolver} vs resolved=${resolvedResolver}`,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      let parsedPrice = c.priceAtomic ?? "30000";
      if (priceText) {
        try {
          const pj = JSON.parse(priceText);
          if (pj.amount) parsedPrice = String(pj.amount);
        } catch {
          if (/^\d+$/.test(priceText)) parsedPrice = priceText;
        }
      }

      let parsedRep = c.reputation;
      if (repText) {
        try {
          parsedRep = JSON.parse(repText);
        } catch {}
      }

      const verifiedPayTo = payTo || c.payTo;
      const verifiedEndpoint = endpoint || c.endpoint || `${serverUrl}/a/${c.label}/run`;

      verifiedCandidates.push({
        label: c.label,
        ensName: c.ensName,
        skill: c.skill,
        priceAtomic: parsedPrice,
        payTo: verifiedPayTo,
        endpoint: verifiedEndpoint,
        reputation: parsedRep,
      });

      emit({
        kind: "verify",
        label: c.label,
        ensName: c.ensName,
        ok: true,
        resolver: resolvedResolver,
        payTo: verifiedPayTo,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      emit({
        kind: "verify",
        label: c.label,
        ensName: c.ensName,
        ok: false,
        reason: `Verification error: ${err instanceof Error ? err.message : err}`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  if (verifiedCandidates.length === 0) {
    const msg = "No candidates passed on-chain ENS verification";
    emit({ kind: "error", message: msg, step: "verify", timestamp: new Date().toISOString() });
    return { success: false, error: msg };
  }

  // 4. DECIDE (with fallback queue)
  // Deterministic ranking: filter by minSuccess & budget, sort by price asc, then success desc
  const eligibleQueue: Array<{
    label: string;
    ensName: string;
    skill: string;
    priceAtomic: string;
    payTo: string;
    endpoint: string;
    reputation: any;
    totalJobCost: bigint;
  }> = [];

  const rejectedList: Array<{ label: string; reason: string }> = [];

  for (const vc of verifiedCandidates) {
    const totalJobCost = BigInt(vc.priceAtomic) * BigInt(declaredUnits);
    const spendCheck = validateSpend(totalJobCost, rules);

    if (!spendCheck.allowed) {
      rejectedList.push({ label: vc.label, reason: spendCheck.reason ?? "Exceeds spending rules" });
      continue;
    }

    const jobs = vc.reputation?.jobs ?? 0;
    const success = vc.reputation?.success ?? 0;
    if (jobs > 0 && success / jobs < rules.minSuccess) {
      rejectedList.push({
        label: vc.label,
        reason: `Success rate ${(success / jobs).toFixed(2)} is below minimum ${rules.minSuccess}`,
      });
      continue;
    }

    eligibleQueue.push({ ...vc, totalJobCost });
  }

  // Sort queue: price asc, success count desc, p50 latency asc
  eligibleQueue.sort((a, b) => {
    if (a.totalJobCost !== b.totalJobCost) {
      return a.totalJobCost < b.totalJobCost ? -1 : 1;
    }
    const succA = a.reputation?.success ?? 0;
    const succB = b.reputation?.success ?? 0;
    if (succB !== succA) return succB - succA;
    const p50A = a.reputation?.p50_ms ?? 999999;
    const p50B = b.reputation?.p50_ms ?? 999999;
    return p50A - p50B;
  });

  if (eligibleQueue.length === 0) {
    const msg = `All candidates rejected by spending rules or reputation threshold: ${rejectedList.map((r) => `${r.label} (${r.reason})`).join("; ")}`;
    emit({ kind: "error", message: msg, step: "decide", timestamp: new Date().toISOString() });
    return { success: false, error: msg };
  }

  // 5. TRY CANDIDATES IN ORDER (Loop with Fallback on Refusal / Payment Failure)
  for (let i = 0; i < eligibleQueue.length; i++) {
    const chosen = eligibleQueue[i];
    if (!chosen) continue;
    const competitors = eligibleQueue.filter((_, idx) => idx !== i).filter((c): c is typeof chosen => !!c);

    const rationale = await generateLlmRationale(
      chosen,
      competitors,
      { zgRouterUrl: zgRouter, zgApiKey: zgKey, zgChatModel: zgModel },
    );

    emit({
      kind: "decide",
      chosen: {
        label: chosen.label,
        ensName: chosen.ensName,
        priceAtomic: chosen.priceAtomic,
        payTo: chosen.payTo,
      },
      rationale,
      rejected: rejectedList,
      timestamp: new Date().toISOString(),
    });

    // 5. QUOTE
    let quoteAmount = chosen.totalJobCost.toString();
    try {
      const quoteRes = await fetch(`${serverUrl}/a/${chosen.label}/quote?units=${declaredUnits}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (quoteRes.ok) {
        const quote = (await quoteRes.json()) as any;
        quoteAmount = quote.amount;
        emit({
          kind: "quote",
          label: chosen.label,
          units: declaredUnits,
          amount: quote.amount,
          asset: quote.asset || HEDERA_TESTNET_USDC,
          payTo: quote.payTo || chosen.payTo,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // If quote fails, use on-chain calculated amount
    }

    // 6. PAY + RUN via x402
    if (!buyerId || !buyerKey) {
      const err = "Buyer Hedera credentials (BUYER_HEDERA_ACCOUNT_ID / BUYER_HEDERA_PRIVATE_KEY) missing in environment";
      emit({ kind: "error", message: err, step: "pay", timestamp: new Date().toISOString() });
      return { success: false, error: err };
    }

    const signer = createClientHederaSigner(
      buyerId,
      PrivateKey.fromStringECDSA(buyerKey),
      { network: "hedera:testnet" },
    );

    // Setup x402 client with spend controls and payTo verification policy
    const expectedPayTo = chosen.payTo;
    const xClient = new x402Client()
      .register("hedera:*", new ExactHederaScheme(signer))
      .setSpendControls({
        maxAmountPerPayment: `$${(Number(rules.maxPerJobAtomic) / 1e6).toFixed(2)}`,
      });

    // Register PaymentPolicy: strictly enforce that payment goes to the ENS nightshift.payto address
    if (expectedPayTo) {
      xClient.registerPolicy((_version, requirements) => {
        return requirements.filter((r) => {
          const p = (r as any).payTo;
          return !p || p === expectedPayTo;
        });
      });
    }

    const payFetch = wrapFetchWithPayment(fetch, xClient);

    const form = new FormData();
    if (fileBuffer) {
      form.append("file", new Blob([fileBuffer], { type: fileMime }), fileName);
    } else {
      // Dummy small buffer if no file provided
      form.append("file", new Blob([Buffer.from("dummy audio content")], { type: "audio/mpeg" }), "input.mp3");
    }

    const t0 = performance.now();
    try {
      const runRes = await payFetch(chosen.endpoint, {
        method: "POST",
        headers: {
          "X-Nightshift-Units": declaredUnits.toString(),
        },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });

      // Handle 503 over_budget refusal -> fallback
      if (runRes.status === 503) {
        emit({
          kind: "refused",
          label: chosen.label,
          status: 503,
          reason: "Agent refused job: 0G daily compute budget cap reached",
          timestamp: new Date().toISOString(),
        });
        rejectedList.push({ label: chosen.label, reason: "503 over_budget" });
        continue; // Fallback to next candidate in queue!
      }

      if (!runRes.ok) {
        const errorText = await runRes.text();
        emit({
          kind: "payment_failed",
          label: chosen.label,
          error: `HTTP ${runRes.status}: ${errorText.slice(0, 200)}`,
          timestamp: new Date().toISOString(),
        });
        rejectedList.push({ label: chosen.label, reason: `HTTP ${runRes.status}` });
        continue; // Fallback to next candidate
      }

      // SUCCESS!
      const paymentHeader = runRes.headers.get("PAYMENT-RESPONSE");
      let txId: string | undefined;
      let hashscanUrl: string | undefined;

      if (paymentHeader) {
        try {
          const settle = decodePaymentResponseHeader(paymentHeader);
          txId = settle.transaction;
          hashscanUrl = `https://hashscan.io/testnet/transaction/${txIdForUrl(settle.transaction)}`;
          emit({
            kind: "paid",
            label: chosen.label,
            txId: settle.transaction,
            hashscanUrl,
            amount: quoteAmount,
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Decoding header error
        }
      }

      const rawBody = await runRes.text();
      let transcriptText = rawBody;
      let zgRequestId: string | undefined;
      try {
        const parsed = JSON.parse(rawBody);
        if (parsed.output) transcriptText = parsed.output;
        if (parsed.requestId) zgRequestId = parsed.requestId;
      } catch {}

      const jobId = runRes.headers.get("X-Nightshift-Job") ?? undefined;
      const latencyMs = Math.round(performance.now() - t0);

      // Record spend atomically in .state.json
      recordSpend(BigInt(quoteAmount));

      emit({
        kind: "result",
        label: chosen.label,
        text: transcriptText,
        jobId,
        zgRequestId,
        latencyMs,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        result: transcriptText,
        jobId,
        zgRequestId,
        txId,
        hashscanUrl,
        chosenAgent: chosen.ensName,
      };
    } catch (err) {
      emit({
        kind: "payment_failed",
        label: chosen.label,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
      rejectedList.push({ label: chosen.label, reason: String(err) });
      continue; // Try next candidate
    }
  }

  const finalMsg = "All candidate agents were exhausted or failed during execution";
  emit({ kind: "error", message: finalMsg, step: "pay", timestamp: new Date().toISOString() });
  return { success: false, error: finalMsg };
}
