import { formatUsdc } from "@nightshift/shared/money";

export function formatUsdMicro(amount: bigint | string): string {
  const value = typeof amount === "string" ? BigInt(amount) : amount;
  const formatted = formatUsdc(value);
  return formatted.startsWith("-") ? `-$${formatted.slice(1)}` : `$${formatted}`;
}
