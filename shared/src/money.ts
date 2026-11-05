// Money formatting without floats. USDC amounts are atomic integers (6 decimals).

/** 30000n -> "0.03" */
export function formatUsdc(atomic: bigint | string): string {
  const a = typeof atomic === "string" ? BigInt(atomic) : atomic;
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${frac ? `${whole}.${frac}` : whole}`;
}
