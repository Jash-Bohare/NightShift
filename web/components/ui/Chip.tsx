"use client";

import type { ReactNode } from "react";
import { useState } from "react";

export type ChipRail = "hedera" | "ens" | "0g" | "none";

export interface ChipProps {
  children: ReactNode;
  className?: string;
  copyText?: string;
  href?: string;
  rail?: ChipRail;
}

export function Chip({ children, className = "", copyText, href, rail = "none" }: ChipProps) {
  const [feedback, setFeedback] = useState("");
  const classes = ["chip", rail !== "none" ? `chip--${rail}` : "", className]
    .filter(Boolean)
    .join(" ");

  async function copy(): Promise<void> {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setFeedback("Copied");
    } catch (error) {
      setFeedback(error instanceof Error ? `Copy failed: ${error.message}` : "Copy failed");
    }
  }

  const content = (
    <>
      {rail !== "none" && <span className="chip__dot" aria-hidden="true" />}
      <span>{children}</span>
      {href && <span aria-hidden="true">↗</span>}
    </>
  );

  const copyButton = copyText ? (
    <button className="chip chip__action" type="button" onClick={() => void copy()}>
      copy
    </button>
  ) : null;
  const status = feedback ? (
    <span className="chip__feedback" role="status" aria-live="polite">
      {feedback}
    </span>
  ) : null;

  if (!href) {
    return (
      <span className="chip-group">
        <span className={classes}>{content}</span>
        {copyButton}
        {status}
      </span>
    );
  }

  return (
    <span className="chip-group">
      <a className={classes} href={href} target="_blank" rel="noopener noreferrer">
        {content}
      </a>
      {copyButton}
      {status}
    </span>
  );
}
