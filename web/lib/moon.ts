export function moonLitFraction(creditsLeft: bigint | string, dailyCap: bigint | string): number {
  const left = typeof creditsLeft === "string" ? BigInt(creditsLeft) : creditsLeft;
  const cap = typeof dailyCap === "string" ? BigInt(dailyCap) : dailyCap;

  if (left <= 0n || cap <= 0n) return 0;
  if (left >= cap) return 1;

  return Number((left * 1_000_000n) / cap) / 1_000_000;
}

/** Night-sky tones for worker badges (design tokens only). */
export const BADGE_SKIES = ["--ink", "--blue", "--orange-small", "--green-text", "--red"] as const;

export interface WorkerBadge {
  sky: (typeof BADGE_SKIES)[number];
  /** Crescent rotation in degrees. */
  tilt: number;
  /** Stars in a 0–100 viewBox, kept clear of the moon. */
  stars: { x: number; y: number; r: number }[];
}

/** FNV-1a 32-bit hash: a stable, fast seed for decorative choices. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A decorative badge derived only from the worker's name: the same name always draws the same
 * sky, crescent tilt and stars. It shows no data (credit levels are private), so it is safe on
 * public pages.
 */
export function workerBadge(seed: string): WorkerBadge {
  let h = hash(seed.trim().toLowerCase() || "nightshift");
  // Golden-ratio step + murmur3 finaliser: well-spread values even for similar names.
  const next = () => {
    h = (h + 0x9e3779b9) >>> 0;
    let z = h;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  const sky = BADGE_SKIES[next() % BADGE_SKIES.length]!;
  const tilt = (next() % 120) - 60;
  // Three corner slots around the moon; each badge uses two of them.
  const slots = [
    { x: 22, y: 24 },
    { x: 80, y: 74 },
    { x: 24, y: 76 },
  ];
  const skip = next() % slots.length;
  const stars = slots
    .filter((_, i) => i !== skip)
    .map((s) => ({
      x: s.x + (next() % 7) - 3,
      y: s.y + (next() % 7) - 3,
      r: 2 + (next() % 3) * 0.6,
    }));
  return { sky, tilt, stars };
}
