import type { ReactNode } from "react";

export interface ReceiptRow {
  label: string;
  value: ReactNode;
}

export function Receipt({
  children,
  className = "",
  rows,
  title,
}: {
  children?: ReactNode;
  className?: string;
  rows: ReceiptRow[];
  title: string;
}) {
  return (
    <section className={`receipt ${className}`} aria-label={title}>
      <h2 className="receipt__title">{title}</h2>
      <hr className="receipt__rule" />
      <div className="receipt__rows">
        {rows.map(({ label, value }) => (
          <div className="receipt__row" key={label}>
            <span className="receipt__label">{label}</span>
            <span className="receipt__leader" aria-hidden="true" />
            <span className="receipt__value">{value}</span>
          </div>
        ))}
      </div>
      {children}
    </section>
  );
}
