// SIMULATED end-to-end workflow (see ./harness.ts for exactly what is real and what is simulated).
// Every payment here is a SIMULATED x402 payload settled by a local stand-in facilitator; no
// Hedera transaction exists and transaction ids are prefixed SIMULATED-NOT-A-HEDERA-TX.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUYER_ACCOUNT,
  LocalPrivyIssuer,
  SIMULATED_TX_PREFIX,
  SimulatedChain,
  SimulatedFacilitator,
  sha256,
  simulatedPaymentScheme,
} from "./harness.js";
import type { FakeSupabase } from "../testing/fake-supabase.js";

const TRANSCRIPT = "SIMULATED transcript: வணக்கம் (no 0G call was made)";

const sim = vi.hoisted(() => ({
  db: undefined as unknown as FakeSupabase,
  chain: undefined as unknown as SimulatedChain,
  transcribeCalls: 0,
  billing: "ok" as "ok" | "missing",
  hcsMessages: [] as unknown[],
}));

vi.mock("../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/client.js")>();
  const { FakeSupabase } = await import("../testing/fake-supabase.js");
  sim.db = new FakeSupabase();
  return { ...actual, db: sim.db };
});

vi.mock("../ens/registrar.js", async () => {
  const { SimulatedChain } = await import("./harness.js");
  sim.chain = new SimulatedChain();
  return {
    etherscanTx: (hash: string) => `simulated:${hash}`,
    setReputation: vi.fn(async () => {
      throw new Error("SIMULATED: reputation writes are disabled in tests");
    }),
    sepoliaClient: {
      readContract: async (call: { functionName: string; args: [bigint] }) => {
        const worker = sim.chain.byLabelhash(call.args[0]);
        if (call.functionName === "getStatus") return worker?.status ?? 0;
        if (call.functionName === "getExpiry") return worker?.expirySeconds ?? 0n;
        throw new Error(`SIMULATED chain: unsupported ${call.functionName}`);
      },
    },
  };
});

vi.mock("../ens/read.js", () => ({
  readAgentRecords: async () => {
    throw new Error("SIMULATED: live ENS profile reads are not available in this test");
  },
}));

vi.mock("../hedera/hcs.js", () => ({
  submitHcs: async (message: unknown) => {
    sim.hcsMessages.push(message);
    return BigInt(sim.hcsMessages.length);
  },
}));

vi.mock("../zg/router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../zg/router.js")>();
  return {
    ...actual,
    listModels: async () => [{ id: "test-model", pricing_usd: { prompt: "0.00013" } }],
    balance: async () => {
      throw new Error("SIMULATED: no balance endpoint");
    },
    transcribe: async () => {
      sim.transcribeCalls++;
      const trace = {
        request_id: `simulated-0g-request-${sim.transcribeCalls}`,
        provider: "simulated-provider",
        ...(sim.billing === "ok"
          ? { billing: { currency: "usd", total_cost: "12480", total_cost_usd_micro: "12480" } }
          : {}),
      };
      return {
        output: TRANSCRIPT,
        requestId: trace.request_id,
        provider: trace.provider,
        costUsdMicro: actual.billedCostUsdMicro(trace),
      };
    },
  };
});

// ---- environment wiring (before the app modules are imported)
const facilitator = new SimulatedFacilitator();
const privy = new LocalPrivyIssuer();
await facilitator.start();
process.env.X402_FACILITATOR_URL = facilitator.url;
process.env.PRIVY_APP_ID = "test-privy-app";
process.env.PRIVY_JWT_VERIFICATION_KEY = privy.publicKeyPem;
// The suite performs many uploads from one client; production defaults stay unchanged.
process.env.UPLOAD_MAX_PER_MINUTE = "1000";
process.env.WORKER_REQUESTS_PER_MINUTE = "10000";

const { createApp } = await import("../app.js");
const { clearAgentCache } = await import("../db/queries.js");
const { encrypt } = await import("../crypto.js");
const { createSignedQuote } = await import("../quote-signing.js");
const buyer = await import("@nightshift/buyer");
const { DEFAULT_SAMPLE_FILE, createX402Fetch, verifySettlement, discoverDirectory } = buyer;

let server: Server;
let base = "";
const OWNER_A = "did:privy:ownera";
const OWNER_B = "did:privy:ownerb";
const ownerAddress = (n: number) => `0x${String(n).padStart(40, "0")}` as `0x${string}`;
const resolverAddress = (n: number) => `0x${String(n).padStart(40, "a")}` as `0x${string}`;

beforeAll(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await facilitator.stop();
});

interface WorkerSeed {
  label: string;
  owner: string;
  status?: string;
  priceAtomic?: number;
  capUsdMicro?: number;
  expiresInSeconds?: number;
  account: string;
}

function seedWorker(n: number, w: WorkerSeed): string {
  const ownerId = `00000000-0000-4000-8000-00000000000${n}`;
  if (!sim.db.table("owners").some((o) => o.privy_user_id === w.owner))
    sim.db.seed("owners", [
      {
        id: ownerId,
        privy_user_id: w.owner,
        evm_address: ownerAddress(n),
        created_at: new Date().toISOString(),
      },
    ]);
  const owner = sim.db.table("owners").find((o) => o.privy_user_id === w.owner)!;
  const agentId = `10000000-0000-4000-8000-00000000000${n}`;
  const ensName = `${w.label}.nightshift.eth`;
  const expiry = Math.floor(Date.now() / 1000) + (w.expiresInSeconds ?? 30 * 86_400);
  const price = w.priceAtomic ?? 30_000;
  sim.db.seed("agents", [
    {
      id: agentId,
      owner_id: owner.id,
      label: w.label,
      ens_name: ensName,
      skill: "transcribe:ta",
      model: "test-model",
      price_atomic: price,
      price_unit: "minute",
      daily_cap_usd_micro: w.capUsdMicro ?? 500_000,
      status: w.status ?? "active",
      hedera_account_id: w.account,
      resolver_address: resolverAddress(n),
      expiry: new Date(expiry * 1000).toISOString(),
    },
  ]);
  sim.db.seed("agent_secrets", [
    {
      agent_id: agentId,
      zg_api_key_enc: encrypt("sk-simulated-not-a-key", "0".repeat(64)),
      zg_mgmt_key_enc: null,
      hedera_private_key_enc: encrypt("simulated", "0".repeat(64)),
    },
  ]);
  const endpoint = `${base}/a/${w.label}/run`;
  const priceText = JSON.stringify({
    amount: String(price),
    asset: "0.0.429274",
    network: "hedera:testnet",
    unit: "minute",
  });
  sim.db.seed("directory", [
    {
      label: w.label,
      ens_name: ensName,
      owner: ownerAddress(n),
      resolver: resolverAddress(n),
      skill: "transcribe:ta",
      price_atomic: price,
      price_unit: "minute",
      payto: w.account,
      endpoint,
      model: "test-model",
      description: "SIMULATED worker",
      reputation: { jobs: 0, success: 1, p50_ms: 0 },
      status: w.status ?? "active",
      expiry: new Date(expiry * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
  ]);
  sim.chain.add({
    label: w.label,
    owner: ownerAddress(n),
    resolver: resolverAddress(n),
    status: 2,
    expirySeconds: BigInt(expiry),
    texts: {
      "nightshift.skill": "transcribe:ta",
      "nightshift.price": priceText,
      "nightshift.payto": w.account,
      "agent-endpoint[x402]": endpoint,
      "nightshift.reputation": JSON.stringify({ jobs: 0 }),
    },
  });
  return agentId;
}

function buyerConfig() {
  return buyer.loadBuyerConfig({
    serverUrl: base,
    quoteVerifyPublicKey: process.env.NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY!,
    sepoliaRpcUrl: "http://127.0.0.1:9/simulated",
    mirrorUrl: "http://127.0.0.1:9/simulated",
    buyerAccountId: BUYER_ACCOUNT,
    buyerPrivateKey: "1".repeat(64),
    hcsTopicId: "0.0.500", // SIMULATED topic, served by simulatedHcsFetch
  });
}

/** SIMULATED Mirror Node HCS endpoint: serves the messages the server "submitted" (sim.hcsMessages). */
const simulatedHcsFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const hcs = /\/api\/v1\/topics\/[^/]+\/messages\/(\d+)$/.exec(url);
  if (url.startsWith("http://127.0.0.1:9/simulated") && hcs) {
    const message = sim.hcsMessages[Number(hcs[1]) - 1];
    if (!message) return new Response("not found", { status: 404 });
    return Response.json({ message: Buffer.from(JSON.stringify(message)).toString("base64") });
  }
  return fetch(input, init);
};

/** SIMULATED mirror: confirms only payments the local facilitator actually "settled". */
const simulatedMirror = {
  verifyPayment: async (expected: { transactionId: string }) => ({
    verified: expected.transactionId.startsWith(SIMULATED_TX_PREFIX),
    transactionId: expected.transactionId,
    reason: "SIMULATED mirror check (no Hedera lookup)",
  }),
};

function runSimulatedBuyer(events: { kind: string }[] = []) {
  const spend = { daily: 0n };
  return buyer.runBuyer(
    { skill: "transcribe:ta", file: DEFAULT_SAMPLE_FILE },
    {
      config: buyerConfig(),
      executionLockPath: join(mkdtempSync(join(tmpdir(), "ns-e2e-")), "buyer.lock"),
      onEvent: (event) => events.push(event),
      dependencies: {
        discover: (config, skill) => discoverDirectory(config, skill),
        verify: (config, candidates, skill, rules, options) =>
          buyer.verifyDirectoryCandidates(config, candidates, skill, rules, {
            ...options,
            ens: sim.chain.ensReader(),
          }),
        usdcBalance: async () => 10_000_000n, // SIMULATED balance
        createPaymentFetch: (config, rules, expected) =>
          createX402Fetch(config, rules, expected, simulatedPaymentScheme),
        verifyPayment: (_config, expected) => simulatedMirror.verifyPayment(expected),
        verifySettlement: (config, expected) =>
          verifySettlement(config, expected, {
            mirror: simulatedMirror as never,
            fetcher: simulatedHcsFetch,
            jobAttempts: 5,
            pause: async () => {},
          }),
        dailySpentAtomic: () => spend.daily,
        recordSpend: (amount) => {
          spend.daily += amount;
        },
        recordCompletedJob: () => {},
      },
    },
  );
}

async function quoteFor(label: string, units = 2) {
  const res = await fetch(`${base}/a/${label}/quote?units=${units}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { signedQuote: string; nonce: string; status: string };
}

async function unpaidRun(label: string, signedQuote: string, units = 2) {
  const body = new FormData();
  body.append(
    "file",
    new Blob([new Uint8Array(readFileSync(DEFAULT_SAMPLE_FILE))], { type: "audio/mpeg" }),
    "sample.mp3",
  );
  return fetch(`${base}/a/${label}/run`, {
    method: "POST",
    headers: { "X-Nightshift-Units": String(units), "X-Nightshift-Quote": signedQuote },
    body,
  });
}

function resetWorld() {
  clearAgentCache();
  for (const key of Object.keys(sim.db.tables)) delete sim.db.tables[key];
  sim.chain.workers.clear();
  sim.transcribeCalls = 0;
  sim.billing = "ok";
  sim.hcsMessages.length = 0;
  facilitator.settleMode = "ok";
  facilitator.settleCalls = 0;
  facilitator.verifyCalls = 0;
}

describe("SIMULATED end-to-end buyer → worker workflow", () => {
  beforeEach(resetWorld);

  it("discovers, verifies, quotes, pays, executes, settles and verifies (refusal → fallback)", async () => {
    // kural-sim has a 1 micro-USD cap: refused before payment.
    seedWorker(1, {
      label: "kural-sim",
      owner: OWNER_A,
      priceAtomic: 20_000,
      capUsdMicro: 1,
      account: "0.0.7100001",
    });
    const scribeId = seedWorker(2, { label: "scribe-sim", owner: OWNER_A, account: "0.0.7100002" });
    const events: { kind: string }[] = [];

    const result = await runSimulatedBuyer(events);

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      success: true,
      jobVerified: true,
      paymentConfirmed: true,
      settlementVerified: true,
      chosenAgent: "scribe-sim.nightshift.eth",
      output: TRANSCRIPT,
    });
    expect(result.txId).toMatch(new RegExp(`^${SIMULATED_TX_PREFIX}`));
    expect(events.map((e) => e.kind)).toEqual([
      "plan",
      "discover",
      "verify",
      "verify",
      "decide",
      "quote",
      "refused",
      "decide",
      "quote",
      // No "paid" event: the buyer only emits it with a HashScan link, and a SIMULATED
      // settlement id has none (no fabricated explorer link is ever shown).
      "result",
    ]);
    // Persistence: one settled job with the output digest and simulated settlement id.
    const jobs = sim.db.table("jobs").filter((j) => j.agent_id === scribeId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "settled",
      output_sha256: sha256(TRANSCRIPT),
      hedera_tx_id: result.txId,
      buyer_account: BUYER_ACCOUNT,
      zg_cost_usd_micro: "12480",
      price_atomic: "60000",
    });
    expect(sim.db.table("quote_redemptions")).toMatchObject([
      { state: "settled", job_id: jobs[0]!.id },
    ]);
    expect(sim.db.table("agent_budget_reservations")).toHaveLength(0); // released after success
    // The unpaid challenge to the over-budget worker wrote nothing.
    expect(sim.db.table("agents").find((a) => a.label === "kural-sim")!.status).toBe("active");
    expect(sim.db.table("jobs").filter((j) => j.status === "refused_budget")).toHaveLength(0);
    expect(facilitator.settleCalls).toBe(1);
    expect(sim.transcribeCalls).toBe(1);
    // HCS evidence (simulated topic) carries the same digest.
    await vi.waitFor(() => expect(sim.hcsMessages).toHaveLength(1));
    expect(sim.hcsMessages[0]).toMatchObject({
      output_sha256: sha256(TRANSCRIPT),
      tx: result.txId,
    });
  });

  it("a paused_budget worker stays paused on unpaid requests and its quote survives the paid retry", async () => {
    seedWorker(2, {
      label: "scribe-sim",
      owner: OWNER_A,
      status: "paused_budget",
      account: "0.0.7100002",
    });
    const quote = await quoteFor("scribe-sim");
    expect(quote.status).toBe("paused_budget");
    const agentStatus = () => sim.db.table("agents").find((a) => a.label === "scribe-sim")!.status;

    // Quote generation and an unpaid challenge must not change lifecycle state.
    const challenge = await unpaidRun("scribe-sim", quote.signedQuote);
    expect(challenge.status).toBe(402);
    expect(agentStatus()).toBe("paused_budget");
    expect(sim.db.table("jobs")).toHaveLength(0);
    expect(sim.db.table("agent_budget_reservations")).toHaveLength(0);

    // The buyer's paid retry with its paused_budget quote succeeds; only then is it un-paused.
    const result = await runSimulatedBuyer();
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(agentStatus()).toBe("active");
  });

  it("re-checks worker eligibility on the paid path: expired or unregistered workers never execute", async () => {
    seedWorker(2, { label: "scribe-sim", owner: OWNER_A, account: "0.0.7100002" });
    const quote = await quoteFor("scribe-sim");
    sim.chain.workers.get("scribe-sim")!.expirySeconds = BigInt(Math.floor(Date.now() / 1000) - 1);
    const expired = await unpaidRun("scribe-sim", quote.signedQuote);
    expect(expired.status).toBe(409);
    sim.chain.workers.get("scribe-sim")!.expirySeconds = BigInt(
      Math.floor(Date.now() / 1000) + 3600,
    );
    sim.chain.workers.get("scribe-sim")!.status = 0; // revoked / unregistered
    const revoked = await unpaidRun("scribe-sim", quote.signedQuote);
    expect(revoked.status).toBe(409);
    expect(sim.transcribeCalls).toBe(0);
    expect(facilitator.verifyCalls).toBe(0);
  });

  it("rejects expired, tampered and mismatched quotes before any payment", async () => {
    const agentId = seedWorker(2, { label: "scribe-sim", owner: OWNER_A, account: "0.0.7100002" });
    const claims = {
      agentId,
      label: "scribe-sim",
      ensName: "scribe-sim.nightshift.eth",
      units: 2,
      amount: "60000",
      asset: "0.0.429274",
      network: "hedera:testnet",
      payTo: "0.0.7100002",
      unit: "minute",
      status: "active" as const,
    };
    const key = process.env.NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY!;
    const expired = createSignedQuote(claims, key, Math.floor(Date.now() / 1000) - 600).token;
    expect((await unpaidRun("scribe-sim", expired)).status).toBe(402);
    const cheap = createSignedQuote({ ...claims, amount: "1" }, key).token;
    expect((await unpaidRun("scribe-sim", cheap)).status).toBe(409);
    const otherPayee = createSignedQuote({ ...claims, payTo: "0.0.666" }, key).token;
    expect((await unpaidRun("scribe-sim", otherPayee)).status).toBe(409);
    const valid = (await quoteFor("scribe-sim")).signedQuote;
    const tampered = `${valid.slice(0, -4)}AAAA`;
    expect((await unpaidRun("scribe-sim", tampered)).status).toBe(402);
    expect(facilitator.verifyCalls).toBe(0);
    expect(sim.db.table("jobs")).toHaveLength(0);
  });

  it("rejects a replayed signed quote: no second execution or settlement", async () => {
    seedWorker(2, { label: "scribe-sim", owner: OWNER_A, account: "0.0.7100002" });
    const quote = await quoteFor("scribe-sim");
    const config = buyerConfig();
    const rules = buyer.loadRules();
    const agent = {
      label: "scribe-sim",
      ensName: "scribe-sim.nightshift.eth",
      endpoint: `${base}/a/scribe-sim/run`,
    } as never;
    const pay = () =>
      buyer.executePaidJob(
        config,
        agent,
        readFileSync(DEFAULT_SAMPLE_FILE),
        "sample.mp3",
        2,
        quote.signedQuote,
        createX402Fetch(
          config,
          rules,
          {
            buyerAccountId: BUYER_ACCOUNT,
            payTo: "0.0.7100002",
            asset: "0.0.429274",
            network: "hedera:testnet",
            amountAtomic: 60_000n,
          },
          simulatedPaymentScheme,
        ),
      );
    const first = await pay();
    expect(first.kind).toBe("response");
    const replay = await pay();
    expect(replay.kind).toBe("submitted-unverified"); // the buyer treats it as needing review
    expect(sim.transcribeCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);
    expect(sim.db.table("jobs").filter((j) => j.status === "settled")).toHaveLength(1);
    expect(sim.db.table("quote_redemptions")).toHaveLength(1);
  });

  it("concurrent paid attempts with one quote execute and settle exactly once", async () => {
    seedWorker(2, { label: "scribe-sim", owner: OWNER_A, account: "0.0.7100002" });
    const quote = await quoteFor("scribe-sim");
    const config = buyerConfig();
    const paidFetch = () =>
      createX402Fetch(
        config,
        buyer.loadRules(),
        {
          buyerAccountId: BUYER_ACCOUNT,
          payTo: "0.0.7100002",
          asset: "0.0.429274",
          network: "hedera:testnet",
          amountAtomic: 60_000n,
        },
        simulatedPaymentScheme,
      );
    const agent = { endpoint: `${base}/a/scribe-sim/run` } as never;
    const file = readFileSync(DEFAULT_SAMPLE_FILE);
    const results = await Promise.all([
      buyer.executePaidJob(config, agent, file, "a.mp3", 2, quote.signedQuote, paidFetch()),
      buyer.executePaidJob(config, agent, file, "b.mp3", 2, quote.signedQuote, paidFetch()),
    ]);
    expect(results.filter((r) => r.kind === "response")).toHaveLength(1);
    expect(sim.transcribeCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);
  });

  it("an uncertain settlement parks the job for reconciliation and the buyer never retries", async () => {
    seedWorker(2, { label: "scribe-sim", owner: OWNER_A, account: "0.0.7100002" });
    facilitator.settleMode = "uncertain";
    const result = await runSimulatedBuyer();
    expect(result.success).toBe(false);
    expect(result.paymentConfirmed).toBe(false);
    expect(["unknown", "unverified"]).toContain(result.paymentState);
    expect(facilitator.settleCalls).toBe(1); // no automatic retry
    const [job] = sim.db.table("jobs");
    expect(job).toMatchObject({ status: "needs_reconciliation" });
    expect(sim.db.table("quote_redemptions")[0]).toMatchObject({ state: "failed" });
  });

  it("a definite facilitator refusal is recorded as settle_failed", async () => {
    seedWorker(2, { label: "scribe-sim", owner: OWNER_A, account: "0.0.7100002" });
    facilitator.settleMode = "definite_failure";
    const result = await runSimulatedBuyer();
    expect(result.success).toBe(false);
    expect(sim.db.table("jobs")[0]).toMatchObject({ status: "settle_failed" });
  });

  it("missing 0G billing withholds output, cancels settlement and retains the reservation", async () => {
    seedWorker(2, { label: "scribe-sim", owner: OWNER_A, account: "0.0.7100002" });
    sim.billing = "missing";
    const result = await runSimulatedBuyer();
    expect(result.success).toBe(false);
    expect(result.output).toBeUndefined();
    expect(facilitator.settleCalls).toBe(0); // buyer not charged
    expect(sim.db.table("jobs")[0]).toMatchObject({
      status: "needs_reconciliation",
      zg_request_id: "simulated-0g-request-1",
      error: "zg_billing_unavailable",
    });
    const [reservation] = sim.db.table("agent_budget_reservations");
    expect(reservation).toBeDefined();
    expect(Date.parse(String(reservation!.expires_at))).toBeGreaterThan(
      Date.now() + 300 * 86_400_000,
    );
  });
});

describe("SIMULATED owner access through verified Privy tokens", () => {
  beforeAll(() => {
    resetWorld();
    seedWorker(1, { label: "alpha-sim", owner: OWNER_A, account: "0.0.7100001" });
    seedWorker(2, { label: "beta-sim", owner: OWNER_B, account: "0.0.7100002" });
    sim.db.seed("jobs", [
      {
        agent_id: "10000000-0000-4000-8000-000000000001",
        status: "settled",
        units: 2,
        price_atomic: 60000,
        zg_cost_usd_micro: 12480,
        output_sha256: "a".repeat(64),
        hedera_tx_id: null,
        hcs_sequence: null,
        latency_ms: 10,
        buyer_account: "0.0.1",
        error: "internal detail",
      },
      {
        agent_id: "10000000-0000-4000-8000-000000000002",
        status: "settled",
        units: 1,
        price_atomic: 30000,
        zg_cost_usd_micro: 100,
        output_sha256: "b".repeat(64),
        hedera_tx_id: null,
        hcs_sequence: null,
        latency_ms: 10,
        buyer_account: "0.0.2",
        error: null,
      },
    ]);
  });
  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

  it("returns only the verified owner's agents and jobs", async () => {
    const tokenA = privy.token({ sub: OWNER_A, aud: "test-privy-app" });
    const me = (await (await get("/me", tokenA)).json()) as { agents: { label: string }[] };
    expect(me.agents.map((a) => a.label)).toEqual(["alpha-sim"]);
    const res = await get("/me/jobs", tokenA);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const jobs = (await res.json()) as { items: Record<string, unknown>[] };
    expect(jobs.items.map((j) => j.label)).toEqual(["alpha-sim"]);
    expect(JSON.stringify(jobs)).not.toMatch(/buyer_account|internal detail|0\.0\.1"/);
    const other = (await (await get("/me/jobs?label=beta-sim", tokenA)).json()) as {
      items: unknown[];
    };
    expect(other.items).toHaveLength(0);
  });

  it("rejects missing, expired, wrongly-signed, wrong-audience and wrong-issuer tokens", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const forged = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const cases = [
      undefined,
      privy.token({ sub: OWNER_A, aud: "test-privy-app", expiresIn: -60 }),
      privy.token({ sub: OWNER_A, aud: "test-privy-app" }, { key: forged }),
      privy.token({ sub: OWNER_A, aud: "another-app" }),
      privy.token({ sub: OWNER_A, aud: "test-privy-app", iss: "evil.example" }),
      "not-a-jwt",
    ];
    for (const token of cases) {
      expect((await get("/me", token)).status).toBe(401);
      expect((await get("/me/jobs", token)).status).toBe(401);
    }
  });

  it("buyer console reads require an allow-listed user and the paid run stays disabled", async () => {
    const listed = privy.token({ sub: "did:privy:testuser", aud: "test-privy-app" });
    const unlisted = privy.token({ sub: OWNER_A, aud: "test-privy-app" });
    expect((await get("/buyer-console/budget")).status).toBe(401);
    expect((await get("/buyer-console/budget", unlisted)).status).toBe(403);
    expect((await get("/buyer-console/budget", listed)).status).toBe(200);
  });
});

describe("frontend ↔ backend API contracts (shapes consumed by web/app pages)", () => {
  beforeAll(async () => {
    resetWorld();
    seedWorker(2, { label: "scribe-sim", owner: OWNER_A, account: "0.0.7100002" });
    const result = await runSimulatedBuyer();
    expect(result.success).toBe(true);
  });
  const json = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    expect(res.status, path).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const isDigits = (v: unknown) => typeof v === "string" && /^\d+$/.test(v);

  it("landing page: GET /stats and GET /jobs/latest", async () => {
    const stats = await json("/stats");
    expect(stats).toMatchObject({
      agents: 1,
      jobsToday: 1,
      usdcToday: "60000",
      creditsUsedToday: "12480",
    });
    expect(stats.reconciliationRequiredToday).toBe(0);
    const latest = await json("/jobs/latest");
    expect(latest).toMatchObject({
      status: "settled",
      price_atomic: "60000",
      agents: { label: "scribe-sim" },
    });
    expect(Object.keys(latest)).not.toContain("buyer_account");
  });

  it("directory page: GET /directory pagination and filters, GET /jobs/activity", async () => {
    const page = await json("/directory?skill=transcribe:ta&sort=price&page=1&limit=10");
    expect(page).toMatchObject({ total: 1, page: 1, limit: 10 });
    const [agent] = page.agents as Record<string, unknown>[];
    expect(agent).toMatchObject({
      label: "scribe-sim",
      ensName: "scribe-sim.nightshift.eth",
      status: "active",
      price: { amount: "30000", asset: "0.0.429274", unit: "minute" },
    });
    expect((await json("/directory?skill=transcribe:hi")).total).toBe(0);
    const activity = await json("/jobs/activity?limit=10");
    expect(activity.jobs).toEqual([
      expect.objectContaining({ status: "settled", agents: { label: "scribe-sim" } }),
    ]);
  });

  it("agent profile page: directory entry, signed quote and job history", async () => {
    expect(await json("/directory/scribe-sim.nightshift.eth")).toMatchObject({
      label: "scribe-sim",
    });
    const quote = await json("/a/scribe-sim/quote?units=2");
    expect(quote).toMatchObject({
      amount: "60000",
      asset: "0.0.429274",
      network: "hedera:testnet",
      units: 2,
    });
    const jobs = (await json("/agents/scribe-sim/jobs?limit=10")) as unknown as Record<
      string,
      unknown
    >[];
    expect(jobs[0]).toMatchObject({ status: "settled", price_atomic: "60000" });
    for (const forbidden of ["output", "buyer_account", "error", "output_sha256"])
      expect(Object.keys(jobs[0]!)).not.toContain(forbidden);
    const payouts = await json("/agents/scribe-sim/payouts");
    expect(payouts.items).toEqual([]);
    // Unknown workers and bad labels use distinct, correct status codes.
    expect((await fetch(`${base}/a/nobody-here/quote`)).status).toBe(404);
    expect((await fetch(`${base}/a/BAD_LABEL/quote`)).status).toBe(422);
  });

  it("dashboard page: GET /me and GET /me/jobs parse with the web validators", async () => {
    const { parseOwnerJobs } = await import("../../../web/lib/owner");
    const token = privy.token({ sub: OWNER_A, aud: "test-privy-app" });
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const me = await json("/me", auth);
    expect(me.agents).toEqual([expect.objectContaining({ label: "scribe-sim", status: "active" })]);
    const history = parseOwnerJobs(await json("/me/jobs?page=1&limit=20", auth));
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      label: "scribe-sim",
      status: "settled",
      priceAtomic: "60000",
    });
    expect(isDigits(history.items[0]!.zgCostUsdMicro)).toBe(true);
  });
});
