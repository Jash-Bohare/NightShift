// Launch wizard logic (docs/06 /launch). Pure and unit-tested; the page only renders it.

/** "0.03" USDC/USD -> 30000n atomic (6 dp). null for anything else, never a float. */
export function atomicFromDecimal(value: string): bigint | null {
  const v = value.trim();
  if (!/^\d+(?:\.\d{0,6})?$/.test(v)) return null;
  const [whole, fraction = ""] = v.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
}

/** 30000n -> "0.03" (trailing zeros trimmed, at least one decimal place kept off for integers). */
export function decimalFromAtomic(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Default daily cap: `pct`% of the owner's 0G credit balance (docs/06 step 4, default 80%). */
export function capFromCredits(creditUsdMicro: bigint, pct = 80): bigint {
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw new RangeError("pct must be 1–100");
  return (creditUsdMicro * BigInt(pct)) / 100n;
}

export const LAUNCH_STEPS = [
  "validate",
  "zg_key",
  "hedera_account",
  "ens_register",
  "drip",
] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];

export const STEP_LABELS: Record<LaunchStep, string> = {
  validate: "Checking the name on Sepolia",
  zg_key: "Testing your 0G key",
  hedera_account: "Creating the worker’s Hedera account",
  ens_register: "Minting the ENS name",
  drip: "Sending Sepolia gas for your record edits",
};

export interface LaunchResult {
  agentId: string;
  ensName: string;
  registerTx: string;
  resolver: string;
  hederaAccount: string;
}

export type LaunchLine =
  | {
      type: "progress";
      step: LaunchStep;
      status: "running" | "done" | "sent" | "skipped" | "failed";
      txHash?: string;
      account?: string;
      resolver?: string;
      reason?: string;
      message?: string;
    }
  | { type: "done"; result: LaunchResult }
  | { type: "error"; error: string; message: string };

const str = (v: unknown): v is string => typeof v === "string";

/** Validate one NDJSON line from POST /me/agents. Returns null for anything malformed. */
export function parseLaunchLine(text: string): LaunchLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (v.type === "progress") {
    if (!(LAUNCH_STEPS as readonly unknown[]).includes(v.step)) return null;
    if (!["running", "done", "sent", "skipped", "failed"].includes(v.status as string)) return null;
    for (const key of ["txHash", "account", "resolver", "reason", "message"])
      if (v[key] !== undefined && !str(v[key])) return null;
    return v as LaunchLine;
  }
  if (v.type === "done") {
    const r = v.result as Record<string, unknown> | undefined;
    if (
      !r ||
      !["agentId", "ensName", "registerTx", "resolver", "hederaAccount"].every((k) => str(r[k]))
    )
      return null;
    return v as LaunchLine;
  }
  if (v.type === "error" && str(v.error) && str(v.message)) return v as LaunchLine;
  return null;
}

export interface StepState {
  step: LaunchStep;
  status: "waiting" | "running" | "done" | "sent" | "skipped" | "failed";
  txHash?: string;
  account?: string;
  note?: string;
}

/** Fold progress lines into one row per step, in launch order. */
export function stepStates(lines: readonly LaunchLine[]): StepState[] {
  const rows = new Map<LaunchStep, StepState>(
    LAUNCH_STEPS.map((step) => [step, { step, status: "waiting" }]),
  );
  for (const line of lines) {
    if (line.type !== "progress") continue;
    const prev = rows.get(line.step)!;
    rows.set(line.step, {
      ...prev,
      status: line.status,
      ...(line.txHash ? { txHash: line.txHash } : {}),
      ...(line.account ? { account: line.account } : {}),
      ...(line.reason || line.message ? { note: line.reason ?? line.message } : {}),
    });
  }
  return [...rows.values()];
}

/** Read an NDJSON response body line by line. Throws on a malformed line. */
export async function readLaunchStream(
  body: ReadableStream<Uint8Array>,
  onLine: (line: LaunchLine) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    if (done) buffer += decoder.decode();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const text = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!text) continue;
      const line = parseLaunchLine(text);
      if (!line) throw new Error("The server sent a malformed launch update.");
      onLine(line);
    }
    if (done) break;
  }
  const rest = buffer.trim();
  if (rest) {
    const line = parseLaunchLine(rest);
    if (!line) throw new Error("The server sent a malformed launch update.");
    onLine(line);
  }
}
