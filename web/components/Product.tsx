"use client";

import type { ReactNode } from "react";
import Link from "next/link";

export function PageFrame({
  kicker,
  title,
  accent,
  description,
  actions,
  children,
}: {
  kicker: string;
  title: string;
  accent?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="wrap product-page">
      <div className="page-heading">
        <div>
          <div className="kick">{kicker}</div>
          <h1 className="display-title riso">
            {title} {accent && <span className="text-orange">{accent}</span>}
          </h1>
          {description && <p className="page-description">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </main>
  );
}

export function LoadingPanel({ label = "Loading live Nightshift data…" }: { label?: string }) {
  return (
    <div className="state-panel" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <div>
        <strong>Clouds over the night shift.</strong>
        <p>{message}</p>
      </div>
      {onRetry && (
        <button className="button button--small" type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyPanel({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="state-panel state-panel--empty">
      <span className="empty-moon" aria-hidden="true">
        ☾
      </span>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action && (
        <Link className="button button--ink button--small" href={action.href}>
          {action.label}
        </Link>
      )}
    </div>
  );
}

export function CopyButton({ value, label = "copy" }: { value: string; label?: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      window.prompt("Copy this value", value);
    }
  };
  return (
    <button className="chip chip__action" type="button" onClick={() => void copy()}>
      {label}
    </button>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}
