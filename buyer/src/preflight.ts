import { createPublicClient, http, isAddressEqual } from "viem";
import { sepolia } from "viem/chains";
import { createEnsReader, discoverDirectory, verifyDirectoryCandidates } from "./discovery.js";
import { loadBuyerPublicConfig, type BuyerPublicConfig } from "./config.js";
import { fetchWorkerQuote } from "./quote.js";
import { loadRules } from "./spending.js";

export type PreflightStatus = "PASS" | "FAIL" | "NOT CONFIGURED";
export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  detail: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  exitCode: 0 | 1 | 2;
}

export interface PreflightOptions {
  fetcher?: typeof fetch;
  publicConfig?: BuyerPublicConfig;
  skill?: string;
}

const isConfigured = (name: string) => Boolean(process.env[name]?.trim());
const safeError = (error: unknown) =>
  error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[URL]") : "check failed";

export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const add = (name: string, status: PreflightStatus, detail: string) =>
    checks.push({ name, status, detail });
  const fetcher = options.fetcher ?? fetch;
  const configNames = [
    "BUYER_SERVER_URL",
    "SEPOLIA_RPC_URL",
    "HEDERA_MIRROR_URL",
    "NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY",
  ];
  const missing = configNames.filter((name) => !isConfigured(name));
  add(
    "Public buyer configuration",
    missing.length ? "NOT CONFIGURED" : "PASS",
    missing.length
      ? `Missing: ${missing.join(", ")}`
      : "Server, RPC, mirror, and quote key are configured",
  );
  const paymentMissing = ["BUYER_HEDERA_ACCOUNT_ID", "BUYER_HEDERA_PRIVATE_KEY"].filter(
    (name) => !isConfigured(name),
  );
  add(
    "Payment credentials (not used)",
    paymentMissing.length ? "NOT CONFIGURED" : "PASS",
    paymentMissing.length
      ? `Missing: ${paymentMissing.join(", ")}; preflight remains read-only`
      : "Configured; preflight will not read or use these credentials",
  );
  if (missing.length) {
    add(
      "Server, ENS, quote, mirror, and job-status checks",
      "NOT CONFIGURED",
      "Required public configuration is incomplete",
    );
    return { checks, exitCode: 2 };
  }

  let config: BuyerPublicConfig;
  try {
    config = options.publicConfig ?? loadBuyerPublicConfig();
  } catch (error) {
    add("Public buyer configuration", "FAIL", safeError(error));
    return { checks, exitCode: 1 };
  }

  try {
    const response = await fetcher(new URL("/health", config.serverUrl), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
    const health = (await response.json()) as { ok?: unknown };
    if (health.ok !== true) throw new Error("health did not report ok");
    add("Server health", "PASS", "NightShift health endpoint is reachable");
  } catch (error) {
    add("Server health", "FAIL", safeError(error));
  }

  let directoryAvailable = false;
  let verifiedWorkers: Awaited<ReturnType<typeof verifyDirectoryCandidates>> = [];
  const skill = options.skill ?? process.env.PREFLIGHT_SKILL ?? "transcribe:ta";
  try {
    const candidates = await discoverDirectory(config, skill, { fetcher });
    directoryAvailable = true;
    add(
      "Directory",
      "PASS",
      `Directory endpoint is reachable; ${candidates.length} candidate(s) for ${skill}`,
    );
    if (candidates.length) {
      verifiedWorkers = await verifyDirectoryCandidates(config, candidates, skill, loadRules(), {
        fetcher,
      });
      add(
        "Sepolia ENS worker registration",
        verifiedWorkers.length ? "PASS" : "FAIL",
        verifiedWorkers.length
          ? `${verifiedWorkers.length} directory candidate(s) passed resolver, registry, expiry, and record checks`
          : "No candidate passed on-chain identity and expiry verification",
      );
    } else {
      add(
        "Sepolia ENS worker registration",
        "NOT CONFIGURED",
        `No workers are currently listed for ${skill}`,
      );
    }
  } catch (error) {
    add(
      directoryAvailable ? "Sepolia ENS worker registration" : "Directory",
      "FAIL",
      safeError(error),
    );
  }

  try {
    const rpc = createPublicClient({ chain: sepolia, transport: http(config.sepoliaRpcUrl) });
    const chainId = await rpc.getChainId();
    if (chainId !== 11155111) throw new Error(`RPC chain id is ${chainId}, expected 11155111`);
    const [registrarCode, registryCode] = await Promise.all([
      rpc.getCode({ address: config.registrarAddress }),
      rpc.getCode({ address: config.userRegistryAddress }),
    ]);
    if (!registrarCode || registrarCode === "0x" || !registryCode || registryCode === "0x")
      throw new Error("configured registrar or UserRegistry has no deployed code");
    const reader = createEnsReader(config);
    if (!(await isAddressEqual(await reader.registrarRegistry(), config.userRegistryAddress)))
      throw new Error("deployed registrar points to a different UserRegistry");
    add(
      "Sepolia RPC and deployments",
      "PASS",
      "Chain ID and configured registrar/UserRegistry code verified",
    );
  } catch (error) {
    add("Sepolia RPC and deployments", "FAIL", safeError(error));
  }

  const candidate = verifiedWorkers[0];
  if (!candidate) {
    add(
      "Signed quote",
      "NOT CONFIGURED",
      "A verified worker is required to retrieve a real signed quote",
    );
  } else {
    try {
      const quote = await fetchWorkerQuote(config, candidate.label, 1, { fetcher });
      if (quote.expiresAt <= Date.now()) throw new Error("server quote is expired");
      add(
        "Signed quote",
        "PASS",
        "Quote retrieved and signature, worker, price, issue time, and expiry validated",
      );
      add(
        "Quote/status signing-key configuration",
        "PASS",
        "Server quote-signing public key verifies a live signed quote",
      );
    } catch (error) {
      add("Signed quote", "FAIL", safeError(error));
      add(
        "Quote/status signing-key configuration",
        "NOT CONFIGURED",
        "Could not verify the live server quote-signing key",
      );
    }
  }

  try {
    const response = await fetcher(
      new URL("/jobs/00000000-0000-4000-8000-000000000000/status", config.serverUrl),
      {
        headers: { Authorization: "Bearer preflight-invalid-capability" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status !== 401)
      throw new Error(`job-status endpoint returned HTTP ${response.status}, expected 401`);
    add(
      "Job-status endpoint authorization",
      "PASS",
      "Endpoint is deployed and rejects an invalid capability",
    );
  } catch (error) {
    add("Job-status endpoint authorization", "FAIL", safeError(error));
  }

  try {
    const response = await fetcher(`${config.mirrorUrl}/api/v1/network/nodes?limit=1`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Hedera Mirror Node returned HTTP ${response.status}`);
    const body = (await response.json()) as { nodes?: unknown };
    if (!Array.isArray(body.nodes)) throw new Error("Hedera Mirror Node response is malformed");
    add("Hedera Mirror Node", "PASS", "Mirror Node network endpoint is reachable");
  } catch (error) {
    add("Hedera Mirror Node", "FAIL", safeError(error));
  }

  return {
    checks,
    exitCode: checks.some((check) => check.status === "FAIL")
      ? 1
      : checks.some((check) => check.status === "NOT CONFIGURED")
        ? 2
        : 0,
  };
}
