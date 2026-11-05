// Live ENS reads through the Universal Resolver (same path buyers use). Cached 30 s per name.
import { OWNER_KEYS, REPUTATION_KEY } from "@nightshift/shared";
import { normalize } from "viem/ens";
import { UpstreamError } from "../errors.js";
import { sepoliaClient } from "./registrar.js";

export interface EnsRecords {
  name: string;
  resolver: string | null;
  texts: Record<string, string>;
}

const cache = new Map<string, { at: number; recs: EnsRecords }>();

export async function readAgentRecords(name: string): Promise<EnsRecords> {
  const hit = cache.get(name);
  if (hit && performance.now() - hit.at < 30_000) return hit.recs;
  try {
    const n = normalize(name);
    const keys = [...OWNER_KEYS, REPUTATION_KEY];
    const [resolver, ...values] = await Promise.all([
      sepoliaClient.getEnsResolver({ name: n }).catch(() => null),
      ...keys.map((key) => sepoliaClient.getEnsText({ name: n, key })),
    ]);
    const texts: Record<string, string> = {};
    keys.forEach((k, i) => {
      const v = values[i];
      if (v) texts[k] = v;
    });
    const recs = { name: n, resolver: resolver ?? null, texts };
    cache.set(name, { at: performance.now(), recs });
    return recs;
  } catch (err) {
    throw new UpstreamError("ens", `read ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
