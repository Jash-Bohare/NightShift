import { useId, type CSSProperties } from "react";
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

  const litFraction = moonLitFraction(creditsLeft, dailyCap);
  const style = {
    width: size,
    height: size,
    "--moon-lit-percent": `${litFraction * 100}%`,
  } as CSSProperties;
  return (
    <span
      className="moon-avatar"
      style={style}
      role="img"
      aria-label={
        label
          ? `${label}: ${Math.round(litFraction * 100)}% of today's credit cap left`
          : "Credits left today"
      }
    >
      <span className="moon-avatar__shade" />
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
