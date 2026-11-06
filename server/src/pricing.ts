// Pure money math. No floats: USDC in atomic units (6 dp), 0G in micro-USD, and 0G unit
// prices in pico-USD (1e-12 USD) because pricing_usd goes down to 1e-12 (qwen-flash).

const PICO_DIGITS = 12;
const PICO_PER_MICRO = 1_000_000n;

/** "0.00013" (USD per unit, from /v1/models pricing_usd) -> 130_000_000n pico-USD. */
export function usdDecimalToPico(dec: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(dec.trim());
  if (!m) throw new Error(`bad USD decimal: ${dec}`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > PICO_DIGITS && /[1-9]/.test(frac.slice(PICO_DIGITS)))
    throw new Error(`USD decimal finer than 1e-12: ${dec}`);
  return BigInt(whole + frac.slice(0, PICO_DIGITS).padEnd(PICO_DIGITS, "0"));
}

/** Estimated cost in micro-USD, rounded up, with a safety factor in percent (120 = ×1.2). */
export function estimateCostUsdMicro(picoPerUnit: bigint, units: bigint, safetyPct = 120n): bigint {
  if (units < 0n || picoPerUnit < 0n) throw new Error("negative units or price");
  const pico = picoPerUnit * units * safetyPct;
  const denom = PICO_PER_MICRO * 100n;
  return (pico + denom - 1n) / denom;
}

/** Billable audio minutes for a duration: rounded up, minimum 1. */
export function audioMinutes(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`bad duration: ${seconds}`);
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * Parse the buyer's `X-Nightshift-Units` header. Returns whole units (fractions round up,
 * minimum 1), or null when absent/invalid. Caps at 10_000 to keep prices sane.
 */
export function parseDeclaredUnits(header: string | undefined | null): number | null {
  if (header === undefined || header === null || header.trim() === "") return null;
  if (!/^\d+(\.\d+)?$/.test(header.trim())) return null;
  const n = Math.max(1, Math.ceil(Number(header)));
  return n <= 10_000 ? n : null;
}

/** Total USDC price (atomic) for a job: per-unit price × whole units (min 1). */
export function priceFor(priceAtomicPerUnit: bigint, units: number): bigint {
  if (priceAtomicPerUnit < 0n) throw new Error("negative price");
  return priceAtomicPerUnit * BigInt(Math.max(1, Math.ceil(units)));
}

/**
 * Launch-wizard price suggestion (docs/06 step 3): `multiple` × the 0G cost of one billed unit,
 * in USDC atomic units (1 atomic = 1e-6 USDC, treated as 1 micro-USD), rounded up.
 */
export function suggestedPriceAtomic(
  picoPerMeterUnit: bigint,
  meterPerUnit: bigint,
  multiple = 4n,
): { costUsdMicroPerUnit: bigint; suggestedAtomic: bigint } {
  if (picoPerMeterUnit < 0n || meterPerUnit <= 0n || multiple <= 0n)
    throw new Error("invalid pricing input");
  const pico = picoPerMeterUnit * meterPerUnit;
  const costUsdMicroPerUnit = (pico + PICO_PER_MICRO - 1n) / PICO_PER_MICRO;
  return {
    costUsdMicroPerUnit,
    suggestedAtomic: (pico * multiple + PICO_PER_MICRO - 1n) / PICO_PER_MICRO,
  };
}
