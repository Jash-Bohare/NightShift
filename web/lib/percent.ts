export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed((value * 100) % 1 === 0 ? 0 : 1)}%`;
}
