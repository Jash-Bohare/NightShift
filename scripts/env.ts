// Loads the repo-root .env for spikes and one-off scripts.
import { readFileSync, writeFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { fileURLToPath } from "node:url";

// Node's 250 ms per-address connect budget is too short on this WSL network (IPv6 is
// unreachable and the IPv4 handshake to Alchemy takes ~2.5 s), so fetch fails outright.
setDefaultAutoSelectFamilyAttemptTimeout(5_000);

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

process.loadEnvFile(ENV_PATH);

export function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name} (see .env.example)`);
  return value;
}

export function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value !== "0.0." ? value : undefined;
}

// Writes KEY=value into .env (replacing an existing line or appending), so
// generated secrets never have to be printed.
export function upsertEnv(name: string, value: string): void {
  const text = readFileSync(ENV_PATH, "utf8");
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(ENV_PATH, re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`);
  process.env[name] = value;
}
