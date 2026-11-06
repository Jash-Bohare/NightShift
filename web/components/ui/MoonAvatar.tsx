import type { CSSProperties } from "react";
import { moonLitFraction } from "../../lib/moon";

export interface MoonAvatarProps {
  creditsLeft?: bigint | string;
  dailyCap?: bigint | string;
  label?: string;
  size?: 24 | 34 | 44 | 60 | 132;
}

export function MoonAvatar({ creditsLeft, dailyCap, label, size = 44 }: MoonAvatarProps) {
  const known = creditsLeft !== undefined && dailyCap !== undefined;
  const litFraction = known ? moonLitFraction(creditsLeft, dailyCap) : null;
  const style = {
    width: size,
    height: size,
    ...(litFraction === null ? {} : { "--moon-lit-percent": `${litFraction * 100}%` }),
  } as CSSProperties;

  return (
    <span
      className={`moon-avatar${known ? "" : " moon-avatar--unknown"}`}
      style={style}
      role="img"
      aria-label={
        label
          ? `${label} ${known ? "credits remaining" : "credit balance unavailable"}`
          : "Credit balance unavailable"
      }
      title={known ? undefined : "Credit balance unavailable"}
    >
      {known ? <span className="moon-avatar__shade" /> : <span aria-hidden="true">?</span>}
    </span>
  );
}
