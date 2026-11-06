// GET /me/zg-credits: the signed-in owner's live 0G credit balance, read with the read-only mk- keys
// stored for their workers (0G GET /v1/account/balance). Read-only; keys are never returned.
// Workers that share one 0G account (the same key) are reported once, with all their labels.
import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authenticatePrivyUser } from "../buyer-console-auth.js";
import { env } from "../config.js";
import { decrypt } from "../crypto.js";
import { db } from "../db/client.js";
import { ownerForUser } from "../db/owners.js";
import { UpstreamError } from "../errors.js";
import { logError } from "../log.js";
import { balance as zgBalance } from "../zg/router.js";

export const meCreditsRouter = Router();

const Micro = z.string().regex(/^\d{1,30}$/);
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: Account }>();

interface Account {
  address: string | null;
  creditBalanceUsdMicro: string;
  totalBalanceUsdMicro: string;
}

/** Test hook. */
export function clearCreditCache(): void {
  cache.clear();
}

async function readAccount(mgmtKey: string): Promise<Account> {
  const id = createHash("sha256").update(mgmtKey).digest("hex");
  const hit = cache.get(id);
  if (hit && performance.now() - hit.at < CACHE_MS) return hit.value;
  const raw = await zgBalance(mgmtKey);
  const credit = Micro.safeParse(String(raw.credit_balance ?? ""));
  const total = Micro.safeParse(String(raw.total_balance ?? ""));
  if (!credit.success || !total.success)
    throw new UpstreamError("0g", "balance response is malformed");
  const value: Account = {
    address: typeof raw.address === "string" ? raw.address : null,
    creditBalanceUsdMicro: credit.data,
    totalBalanceUsdMicro: total.data,
  };
  cache.set(id, { at: performance.now(), value });
  return value;
}

meCreditsRouter.get("/me/zg-credits", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const privyUserId = await authenticatePrivyUser(req.header("authorization"));
  const owner = await ownerForUser(privyUserId);
  const readAt = new Date().toISOString();
  if (!owner) {
    res.json({ accounts: [], readAt });
    return;
  }
  const rows = await db
    .from("agents")
    .select("label,agent_secrets(zg_mgmt_key_enc)")
    .eq("owner_id", owner.id)
    .order("created_at", { ascending: true });
  if (rows.error) throw new UpstreamError("db", `owner 0G keys: ${rows.error.message}`);

  // Group workers by their (decrypted) management key so one 0G account is read once.
  const groups = new Map<string, string[]>();
  for (const row of (rows.data ?? []) as { label: string; agent_secrets: unknown }[]) {
    const secrets = Array.isArray(row.agent_secrets) ? row.agent_secrets[0] : row.agent_secrets;
    const enc = (secrets as { zg_mgmt_key_enc?: unknown } | null | undefined)?.zg_mgmt_key_enc;
    if (typeof enc !== "string" || !enc) continue;
    let key: string;
    try {
      key = decrypt(enc, env.SECRETS_MASTER_KEY);
    } catch (error) {
      logError("db", `cannot decrypt the 0G management key of ${row.label}`, error);
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), row.label]);
  }

  const accounts = await Promise.all(
    [...groups].map(async ([key, workers]) => {
      try {
        return { ...(await readAccount(key)), workers };
      } catch (error) {
        logError("0g", `0G balance for ${workers.join(", ")} unavailable`, error);
        return { workers, error: "0G balance unavailable right now" };
      }
    }),
  );
  res.json({ accounts, readAt });
});
