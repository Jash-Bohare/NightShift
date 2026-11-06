import { useId } from "react";
import { moonLitFraction, workerBadge } from "../../lib/moon";

export interface MoonAvatarProps {
  creditsLeft?: bigint | string;
  dailyCap?: bigint | string;
  label?: string;
  /** Name the decorative badge is drawn from (defaults to `label`). */
  seed?: string;
  size?: 24 | 34 | 44 | 60 | 132;
}

/**
 * With credit data (owner views) the moon's lit part is the share of today's 0G cap left.
 * Without it (public views) a decorative night-sky badge drawn from the worker's name is shown
 * instead; it encodes no data.
 */
export function MoonAvatar({ creditsLeft, dailyCap, label, seed, size = 44 }: MoonAvatarProps) {
  const known = creditsLeft !== undefined && dailyCap !== undefined;
  if (!known) return <WorkerBadge label={label} seed={seed ?? label ?? ""} size={size} />;

  return (
    <CreditMoon
      litFraction={moonLitFraction(creditsLeft, dailyCap)}
      label={label}
      seed={seed ?? label ?? ""}
      size={size}
    />
  );
}

/**
 * Owner view: the worker's night-sky badge with a moon whose lit part (left to right) is the
 * share of today's 0G cap still left. Full moon = nothing spent; dark moon = cap used up.
 */
function CreditMoon({
  litFraction,
  label,
  seed,
  size,
}: {
  litFraction: number;
  label?: string;
  seed: string;
  size: number;
}) {
  const id = `moon-credit-${useId().replace(/:/g, "")}`;
  const badge = workerBadge(seed);
  const percent = Math.round(litFraction * 100);
  return (
    <span
      className="moon-avatar moon-avatar--badge"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ? `${label}: ${percent}% of today's credit cap left` : "Credits left today"}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <defs>
          <clipPath id={id}>
            <circle cx="50" cy="50" r="30" />
          </clipPath>
        </defs>
        <rect width="100" height="100" fill={`var(${badge.sky})`} />
        {badge.stars.map((star, index) => (
          <circle cx={star.x} cy={star.y} fill="var(--white)" key={index} r={star.r} />
        ))}
        <circle cx="50" cy="50" r="30" fill="var(--ink)" opacity="0.55" />
        <rect
          clipPath={`url(#${id})`}
          fill="var(--yellow)"
          height="60"
          width={60 * litFraction}
          x="20"
          y="20"
        />
        <circle cx="50" cy="50" r="30" fill="none" stroke="var(--yellow)" strokeWidth="2.5" />
      </svg>
    </span>
  );
}

function WorkerBadge({ label, seed, size }: { label?: string; seed: string; size: number }) {
  const maskId = `moon-badge-${useId().replace(/:/g, "")}`;
  const badge = workerBadge(seed);
  return (
    <span
      className="moon-avatar moon-avatar--badge"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ? `${label} worker badge` : "Worker badge"}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <defs>
          <mask id={maskId}>
            <rect width="100" height="100" fill="#fff" />
            <circle cx="64" cy="38" r="27" fill="#000" />
          </mask>
        </defs>
        <rect width="100" height="100" fill={`var(${badge.sky})`} />
        {badge.stars.map((star, index) => (
          <circle cx={star.x} cy={star.y} fill="var(--white)" key={index} r={star.r} />
        ))}
        <g transform={`rotate(${badge.tilt} 50 50)`}>
          <circle cx="50" cy="50" fill="var(--yellow)" mask={`url(#${maskId})`} r="30" />
        </g>
      </svg>
    </span>
  );
}
