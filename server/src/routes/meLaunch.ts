// POST /me/agents: owner self-service launch (docs/02 F1). Cheap checks (auth, input, wallet
// ownership, per-owner limit, one launch at a time) answer with a normal JSON error. After that
// the response is NDJSON: one {"type":"progress"} line per launch step, then exactly one
// {"type":"done"} or {"type":"error"} line. A client disconnect does not abort a launch.
import express, { Router, type Response } from "express";
import { SKILL_IDS } from "@nightshift/shared";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { launchAgent, type LaunchProgress } from "../agents/launch.js";
import { linkedEthereumWallets } from "../auth/privy-wallets.js";
import { authenticatePrivyUser } from "../buyer-console-auth.js";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { ownerForUser } from "../db/owners.js";
import { syncAgentToDirectory } from "../ens/indexer.js";
import { ApiError, UpstreamError } from "../errors.js";
import { checkPayoutAccount } from "../hedera/mirror.js";
import { logError } from "../log.js";
import { balance as zgBalance } from "../zg/router.js";
import { MAX_DAILY_CAP_USD_MICRO, MAX_PRICE_ATOMIC } from "../limits.js";
import { canLaunch } from "../capabilities.js";

export const meLaunchRouter = Router();

export const LaunchBody = z
  .object({
    label: z.string().regex(/^[a-z0-9-]{3,32}$/, "3–32 chars of a-z, 0-9, -"),
    skill: z.enum(SKILL_IDS),
    priceAtomic: z.string().regex(/^[1-9]\d{0,15}$/, "a positive integer in USDC atomic units"),
    dailyCapUsdMicro: z.string().regex(/^[1-9]\d{0,15}$/, "a positive integer in micro-USD"),
    zgApiKey: z.string().regex(/^sk-[A-Za-z0-9_-]{8,200}$/, "a 0G Router inference key (sk-…)"),
    zgMgmtKey: z
      .string()
      .regex(/^mk-[A-Za-z0-9_-]{8,200}$/, "a 0G management key (mk-…)")
      .optional(),
    hederaPayoutAccount: z
      .string()
      .regex(/^0\.0\.\d{1,12}$/, "a Hedera account id like 0.0.12345")
      .optional(),
    description: z.string().trim().min(1).max(500).optional(),
    ownerAddress: z.string().refine((v) => isAddress(v, { strict: false }), "an EVM address"),
  })
  .strict();

let launchInFlight = false;

/** Test hook. */
export function resetLaunchLock(): void {
  launchInFlight = false;
}

function writeLine(res: Response, line: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`${JSON.stringify(line)}\n`);
}

meLaunchRouter.post("/me/agents", express.json({ limit: "16kb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const privyUserId = await authenticatePrivyUser(req.header("authorization"));
  if (!env.OWNER_LAUNCH_ENABLED)
    throw new ApiError(503, "feature_disabled", "owner launch is disabled on this server");
  if (!canLaunch(privyUserId))
    throw new ApiError(
      403,
      "forbidden",
      "this account is not permitted to launch workers on this server",
    );
  const parsed = LaunchBody.safeParse(req.body);
  if (!parsed.success)
    throw new ApiError(422, "invalid_input", "invalid launch request", parsed.error.issues);
  const body = parsed.data;
  if (BigInt(body.priceAtomic) > MAX_PRICE_ATOMIC)
    throw new ApiError(422, "invalid_input", "price is above 10 USDC per unit");
  if (BigInt(body.dailyCapUsdMicro) > MAX_DAILY_CAP_USD_MICRO)
    throw new ApiError(422, "invalid_input", "daily cap is above the $1,000 limit");

  const ownerAddress = getAddress(body.ownerAddress);
  const wallets = await linkedEthereumWallets(privyUserId);
  if (!wallets.includes(ownerAddress))
    throw new ApiError(
      403,
      "forbidden",
      "the owner address is not a wallet linked to this Privy account",
    );

  const owner = await ownerForUser(privyUserId);
  if (owner) {
    const count = await db
      .from("agents")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", owner.id)
      .neq("status", "failed");
    if (count.error) throw new UpstreamError("db", `count owner agents: ${count.error.message}`);
    if ((count.count ?? 0) >= env.OWNER_MAX_AGENTS)
      throw new ApiError(
        409,
        "invalid_state",
        `this account already has ${env.OWNER_MAX_AGENTS} workers (the limit)`,
      );
  }
  if (body.hederaPayoutAccount) {
    const check = await checkPayoutAccount(body.hederaPayoutAccount);
    if (!check.ok)
      throw new ApiError(
        422,
        "invalid_input",
        check.reason === "not_associated"
          ? `${body.hederaPayoutAccount} is not associated with USDC; associate it first or leave it empty`
          : `${body.hederaPayoutAccount} is not a usable Hedera testnet account`,
      );
  }
  // One launch at a time: every launch signs Sepolia transactions with the same operator key.
  if (launchInFlight)
    throw new ApiError(429, "rate_limited", "another launch is in progress; retry in a minute");
  launchInFlight = true;

  try {
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    try {
      const result = await launchAgent(
        {
          owner: {
            privyUserId,
            evmAddress: ownerAddress,
            ...(body.hederaPayoutAccount ? { hederaPayoutAccount: body.hederaPayoutAccount } : {}),
          },
          label: body.label,
          skill: body.skill,
          priceAtomic: BigInt(body.priceAtomic),
          dailyCapUsdMicro: BigInt(body.dailyCapUsdMicro),
          zgApiKey: body.zgApiKey,
          ...(body.zgMgmtKey ? { zgMgmtKey: body.zgMgmtKey } : {}),
          ...(body.description ? { description: body.description } : {}),
          dripOwnerEth: true,
        },
        (event: LaunchProgress) => writeLine(res, { type: "progress", ...event }),
      );
      // Crons are opt-in, so list the new worker in the directory now (best effort; the
      // indexer also picks it up when it runs).
      await syncAgentToDirectory(body.label).catch((error: unknown) =>
        logError("ens", `directory sync after launch of ${body.label} failed`, error),
      );
      writeLine(res, { type: "done", result });
    } catch (error) {
      const api = error instanceof ApiError ? error : null;
      if (!api) logError("server", `launch of ${body.label} failed`, error);
      writeLine(res, {
        type: "error",
        error:
          api?.code ??
          (error instanceof UpstreamError ? `${error.upstream}_unavailable` : "internal"),
        message:
          api?.message ??
          (error instanceof UpstreamError ? error.message : "launch failed; see server logs"),
      });
    }
    res.end();
  } finally {
    launchInFlight = false;
  }
});

const BalanceBody = z
  .object({
    zgMgmtKey: z.string().regex(/^mk-[A-Za-z0-9_-]{8,200}$/, "a 0G management key (mk-…)"),
  })
  .strict();
const MicroAmount = z.string().regex(/^\d{1,30}$/);

/**
 * Launch wizard step 1: read the owner's 0G balance with their read-only mk- key. The key is used
 * for this one request and is neither stored nor logged; it is stored only if the owner submits
 * it with the launch.
 */
meLaunchRouter.post("/me/zg-balance", express.json({ limit: "4kb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  await authenticatePrivyUser(req.header("authorization"));
  const body = BalanceBody.safeParse(req.body);
  if (!body.success)
    throw new ApiError(422, "invalid_input", "a 0G management key (mk-…) is required");
  let result: Awaited<ReturnType<typeof zgBalance>>;
  try {
    result = await zgBalance(body.data.zgMgmtKey);
  } catch {
    throw new ApiError(
      422,
      "invalid_zg_key",
      "0G rejected this management key or is unreachable; check it has account:read",
    );
  }
  const credit = MicroAmount.safeParse(String(result.credit_balance ?? ""));
  const total = MicroAmount.safeParse(String(result.total_balance ?? ""));
  if (!credit.success || !total.success)
    throw new UpstreamError("0g", "balance response is malformed");
  res.json({ creditBalanceUsdMicro: credit.data, totalBalanceUsdMicro: total.data });
});
