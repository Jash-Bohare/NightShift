// Prefixed logging (CLAUDE.md rule 6). Never pass secrets to these.
export type LogPrefix = "0g" | "hedera" | "ens" | "x402" | "db" | "server" | "cron" | "budget";

const ts = () => new Date().toISOString();

export function log(prefix: LogPrefix, msg: string, extra?: Record<string, unknown>): void {
  console.log(`${ts()} [${prefix}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}`);
}

export function logError(prefix: LogPrefix, msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err === undefined ? "" : String(err);
  console.error(`${ts()} [${prefix}] ${msg}${detail ? `: ${detail}` : ""}`);
}
