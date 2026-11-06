export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed((value * 100) % 1 === 0 ? 0 : 1)}%`;
}

/**
 * Headline for a worker's reputation record. A worker with no settled jobs is "new": a success
 * rate computed from zero jobs (the registrar writes success 1 by default) is not shown as 100%.
 */
export function reputationHeadline(rep: { jobs?: unknown; success?: unknown } | null | undefined): {
  headline: string;
  jobs: number;
} {
  const jobs = typeof rep?.jobs === "number" && Number.isFinite(rep.jobs) ? rep.jobs : 0;
  if (jobs <= 0 || typeof rep?.success !== "number") return { headline: "new", jobs };
  return { headline: formatPercent(rep.success), jobs };
}
