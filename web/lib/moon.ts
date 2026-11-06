export function moonLitFraction(creditsLeft: bigint | string, dailyCap: bigint | string): number {
  const left = typeof creditsLeft === "string" ? BigInt(creditsLeft) : creditsLeft;
  const cap = typeof dailyCap === "string" ? BigInt(dailyCap) : dailyCap;

  if (left <= 0n || cap <= 0n) return 0;
  if (left >= cap) return 1;

  return Number((left * 1_000_000n) / cap) / 1_000_000;
}
