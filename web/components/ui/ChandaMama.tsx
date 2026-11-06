import type { CSSProperties } from "react";
import { useId } from "react";

export type ChandaMamaVariant = "sipping" | "peeking" | "sleeping" | "cloudy" | "cheering";

export interface ChandaMamaProps {
  className?: string;
  decorative?: boolean;
  label?: string;
  size?: number;
  variant?: ChandaMamaVariant;
}

export function ChandaMama({
  className = "",
  decorative = false,
  label = "Chanda Mama, the Nightshift moon",
  size = 300,
  variant = "sipping",
}: ChandaMamaProps) {
  const maskId = `chanda-mask-${useId().replace(/:/g, "")}`;
  const isSleeping = variant === "sleeping";
  const isCloudy = variant === "cloudy";
  const isCheering = variant === "cheering";
  const isPeeking = variant === "peeking";
  const hasCup = variant === "sipping";
  const classes = ["chanda-mama", className, isSleeping ? "chanda-mama__sleep" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      className={classes}
      viewBox="0 0 300 300"
      width={size}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      style={{ "--mascot-size": `${size}px` } as CSSProperties}
    >
      <defs>
        <mask id={maskId}>
          <rect width="300" height="300" fill="#fff" />
          <circle cx="190" cy="118" r="88" fill="#000" />
        </mask>
      </defs>
      <circle cx="157" cy="157" r="110" fill="#3D63DD" opacity=".42" mask={`url(#${maskId})`} />
      <circle cx="150" cy="150" r="110" fill="#FFC93C" mask={`url(#${maskId})`} />
      <path
        d="M78 72 Q128 18 196 34 Q172 52 156 92 Q118 72 78 72 Z"
        fill="#FF6B3D"
        stroke="#1F2547"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M88 74 Q120 64 152 86" stroke="#F4ECDA" strokeWidth="7" fill="none" />
      <circle cx="202" cy="34" r="12" fill="#F4ECDA" stroke="#1F2547" strokeWidth="3" />
      {isCheering ? (
        <>
          <path
            d="M66 142 Q78 130 92 142"
            stroke="#1F2547"
            strokeWidth="4"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M74 186 Q90 202 106 184"
            stroke="#1F2547"
            strokeWidth="4"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M76 190 q-30 4 -34 -22 M104 190 q30 4 34 -22"
            stroke="#1F2547"
            strokeWidth="5"
            fill="none"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          {isPeeking ? (
            <g>
              <circle cx="80" cy="142" r="9" fill="#1F2547" />
              <circle cx="83" cy="139" r="3" fill="#F4ECDA" />
            </g>
          ) : (
            <path
              d="M66 142 Q78 152 92 142"
              stroke="#1F2547"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
            />
          )}
          {!isSleeping && (
            <path
              d="M74 186 Q90 198 106 184"
              stroke="#1F2547"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
            />
          )}
        </>
      )}
      <circle cx="62" cy="168" r="9" fill="#FF6B3D" opacity=".55" />
      {hasCup && (
        <g transform="translate(120 200)">
          <path d="M0 0 L36 0 L31 48 L5 48 Z" fill="#FFFDF6" stroke="#1F2547" strokeWidth="3" />
          <path d="M3 18 L33 18 L31 46 L5 46 Z" fill="#B5652B" />
          <path
            className="chanda-mama__steam"
            d="M10 -6 q5 -8 0 -16 M24 -6 q5 -8 0 -16"
            stroke="#1F2547"
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
          />
        </g>
      )}
      {hasCup && (
        <>
          <ellipse
            cx="112"
            cy="222"
            rx="13"
            ry="10"
            fill="#FFC93C"
            stroke="#1F2547"
            strokeWidth="3"
          />
          <path
            d="M92 150 Q102 162 96 170"
            stroke="#1F2547"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />
          <path
            className="chanda-mama__twinkle"
            d="M240 70 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 l10 -4 Z"
            fill="#FF6B3D"
          />
          <path
            className="chanda-mama__twinkle"
            d="M262 160 l3 7 l7 3 l-7 3 l-3 7 l-3 -7 l-7 -3 l7 -3 Z"
            fill="#3D63DD"
            style={{ animationDelay: "-1s" }}
          />
          <path
            className="chanda-mama__twinkle"
            d="M30 240 l3 7 l7 3 l-7 3 l-3 7 l-3 -7 l-7 -3 l7 -3 Z"
            fill="#FF6B3D"
            style={{ animationDelay: "-1.6s" }}
          />
        </>
      )}
      {isSleeping && (
        <g
          className="chanda-mama__zzz"
          fill="#3D63DD"
          fontFamily="IBM Plex Mono, monospace"
          fontWeight="600"
        >
          <text x="214" y="96" fontSize="34">
            z
          </text>
          <text x="244" y="62" fontSize="24">
            z
          </text>
        </g>
      )}
      {isCloudy && (
        <path
          d="M40 200 a36 36 0 0 1 40 -50 a46 46 0 0 1 86 -6 a34 34 0 0 1 50 30 a30 30 0 0 1 -6 26 Z"
          fill="#FFFDF6"
          stroke="#1F2547"
          strokeWidth="6"
        />
      )}
    </svg>
  );
}
