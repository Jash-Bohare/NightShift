import type { ReactNode } from "react";

export type StampTone = "green" | "red" | "orange" | "blue";

export interface StampProps {
  children: ReactNode;
  className?: string;
  tilt?: "left" | "right" | "none";
  tone: StampTone;
  stampIn?: boolean;
}

export function Stamp({
  children,
  className = "",
  tilt = "none",
  tone,
  stampIn = false,
}: StampProps) {
  const classes = [
    "stamp",
    `stamp--${tone}`,
    tilt !== "none" ? `stamp--tilt-${tilt}` : "",
    stampIn ? "stamp--in" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <span className={classes}>{children}</span>;
}
