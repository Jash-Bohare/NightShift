// Launch an agent (flow F1, docs/02): validate -> test 0G key -> Hedera account -> rows + encrypted
// secrets -> registerAgent on Sepolia -> active. Shared by scripts/create-agent-cli.ts and POST /me/agents.
import { ENS_PARENT_NAME, SKILL_IDS, type SkillId } from "@nightshift/shared";
import type { Address } from "viem";
import { env } from "../config.js";
import { encrypt } from "../crypto.js";
import { db } from "../db/client.js";
import { ApiError, UpstreamError } from "../errors.js";
import {
  available,
  dripIfLow,
  isValidLabel,
  registerAgent,
  etherscanTx,
} from "../ens/registrar.js";
import { buildInitialRecords } from "../ens/records.js";
import { createAgentAccount } from "../hedera/accounts.js";
import { log, logError } from "../log.js";
import { getSkill } from "../skills/index.js";
import { chat } from "../zg/router.js";

export interface LaunchInput {
  owner: { privyUserId: string; evmAddress: Address; hederaPayoutAccount?: string };
  label: string;
  skill: SkillId;
  priceAtomic: bigint;
  dailyCapUsdMicro: bigint;
  zgApiKey: string;
  zgMgmtKey?: string;
  description?: string;
  /** Send Sepolia ETH to a low-balance owner after registration (web launches only). */
  dripOwnerEth?: boolean;
}

export type LaunchStep = "validate" | "zg_key" | "hedera_account" | "ens_register" | "drip";

export type LaunchProgress =
  | { step: LaunchStep; status: "running" }
  | { step: "hedera_account"; status: "done"; account: string }
  | { step: "ens_register"; status: "sent"; txHash: string }
  | { step: "ens_register"; status: "done"; txHash: string; resolver: string }
  | { step: "drip"; status: "done"; txHash: string }
  | { step: "drip"; status: "skipped"; reason: string }
  | { step: "drip"; status: "failed"; message: string }
  | { step: Exclude<LaunchStep, "hedera_account" | "ens_register">; status: "done" };

export interface LaunchResult {
  agentId: string;
  ensName: string;
  registerTx: string;
  resolver: string;
  hederaAccount: string;
}

async function upsertOwner(o: LaunchInput["owner"]): Promise<string> {
  const r = await db
    .from("owners")
    .upsert(
      {
        privy_user_id: o.privyUserId,
        evm_address: o.evmAddress,
        ...(o.hederaPayoutAccount ? { hedera_payout_account: o.hederaPayoutAccount } : {}),
      },
      { onConflict: "privy_user_id" },
    )
    .select("id")
    .single();
  if (r.error) throw new UpstreamError("db", `upsert owner: ${r.error.message}`);
  return (r.data as { id: string }).id;
}

export async function launchAgent(
  input: LaunchInput,
  onProgress: (event: LaunchProgress) => void = () => {},
): Promise<LaunchResult> {
  const { label } = input;
  onProgress({ step: "validate", status: "running" });
  if (!SKILL_IDS.includes(input.skill))
    throw new ApiError(422, "invalid_input", `unknown skill ${input.skill}`);
  const skill = getSkill(input.skill)!;
  if (!(await isValidLabel(label)))
    throw new ApiError(422, "invalid_label", "label must be 3–32 chars of a-z, 0-9, -");
  if (!(await available(label)))
    throw new ApiError(409, "label_taken", `${label}.${ENS_PARENT_NAME} is taken`);
  const existing = await db.from("agents").select("id,status").eq("label", label).maybeSingle();
  if (existing.error)
    throw new UpstreamError("db", `check launch label: ${existing.error.message}`);
  if (existing.data)
    throw new ApiError(
      409,
      "label_taken",
      `label ${label} already has a row (${existing.data.status})`,
    );
  onProgress({ step: "validate", status: "done" });

  // 1-token call proves the sk- key works and has credit (costs a few micro-USD).
  onProgress({ step: "zg_key", status: "running" });
  try {
    await chat({
      key: input.zgApiKey,
      model: env.ZG_CHAT_MODEL,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1,
    });
  } catch (err) {
    throw new ApiError(
      422,
      "invalid_zg_key",
      `0G key test failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  onProgress({ step: "zg_key", status: "done" });
  const ensName = `${label}.${ENS_PARENT_NAME}`;
  const ownerId = await upsertOwner(input.owner);

  const ins = await db
    .from("agents")
    .insert({
      owner_id: ownerId,
      label,
      ens_name: ensName,
      skill: input.skill,
      model: skill.model,
      price_atomic: input.priceAtomic.toString(),
      price_unit: skill.unit,
      daily_cap_usd_micro: input.dailyCapUsdMicro.toString(),
      status: "pending",
    })
    .select("id")
    .single();
  if (ins.error) throw new UpstreamError("db", `insert agent: ${ins.error.message}`);
  const agentId = (ins.data as { id: string }).id;

  let account: Awaited<ReturnType<typeof createAgentAccount>>;
  onProgress({ step: "hedera_account", status: "running" });
  try {
    account = await createAgentAccount(`nightshift ${ensName}`);
    const accountUpdate = await db
      .from("agents")
      .update({ hedera_account_id: account.accountId })
      .eq("id", agentId)
      .select("id")
      .maybeSingle();
    const secrets = await db.from("agent_secrets").insert({
      agent_id: agentId,
      zg_api_key_enc: encrypt(input.zgApiKey, env.SECRETS_MASTER_KEY),
      zg_mgmt_key_enc: input.zgMgmtKey ? encrypt(input.zgMgmtKey, env.SECRETS_MASTER_KEY) : null,
      hedera_private_key_enc: encrypt(account.privateKeyHex, env.SECRETS_MASTER_KEY),
    });
    if (secrets.error)
      throw new UpstreamError("db", `insert secrets for ${agentId}: ${secrets.error.message}`);
    if (accountUpdate.error || !accountUpdate.data)
      throw new UpstreamError(
        "db",
        `persist Hedera account for ${agentId}: ${accountUpdate.error?.message ?? "agent row missing"}`,
      );
  } catch (error) {
    const failed = await db.from("agents").update({ status: "failed" }).eq("id", agentId);
    if (failed.error)
      logError(
        "db",
        `launch ${agentId} failed before ENS registration; status update failed`,
        failed.error,
      );
    throw error;
  }

  onProgress({ step: "hedera_account", status: "done", account: account.accountId });

  let registrationAttempted = false;
  let registration: Awaited<ReturnType<typeof registerAgent>> | undefined;
  try {
    const records = buildInitialRecords({
      label,
      ensName,
      skill: input.skill,
      model: skill.model,
      priceAtomic: input.priceAtomic,
      priceUnit: skill.unit,
      payTo: account.accountId,
      usdcTokenId: env.HEDERA_USDC_TOKEN_ID,
      serverUrl: env.PUBLIC_SERVER_URL,
      webUrl: env.PUBLIC_WEB_URL,
      ...(input.description ? { description: input.description } : {}),
    });
    registrationAttempted = true;
    onProgress({ step: "ens_register", status: "running" });
    registration = await registerAgent(label, input.owner.evmAddress, records, (txHash) =>
      onProgress({ step: "ens_register", status: "sent", txHash }),
    );
    const upd = await db
      .from("agents")
      .update({
        status: "active",
        resolver_address: registration.resolver,
        register_tx: registration.txHash,
        expiry: registration.expiry.toISOString(),
      })
      .eq("id", agentId)
      .select("id")
      .maybeSingle();
    if (upd.error || !upd.data)
      throw new UpstreamError(
        "db",
        `activate registered agent ${agentId}: ${upd.error?.message ?? "agent row missing"}`,
      );
    log("server", "agent launched", {
      ensName,
      agentId,
      hedera: account.accountId,
      tx: etherscanTx(registration.txHash),
    });
    onProgress({
      step: "ens_register",
      status: "done",
      txHash: registration.txHash,
      resolver: registration.resolver,
    });
  } catch (err) {
    logError("ens", `launch of ${ensName} failed; manual reconciliation may be required`, err);
    const patch = registrationAttempted
      ? {
          status: "pending",
          ...(registration
            ? {
                resolver_address: registration.resolver,
                register_tx: registration.txHash,
                expiry: registration.expiry.toISOString(),
              }
            : {}),
        }
      : { status: "failed" };
    const result = await db.from("agents").update(patch).eq("id", agentId);
    if (result.error)
      logError("db", `launch ${agentId} recovery status update failed`, result.error);
    throw err;
  }

  // The agent is live. The drip only helps the owner sign later record edits, so its failure is
  // reported but never fails the launch.
  if (input.dripOwnerEth) {
    onProgress({ step: "drip", status: "running" });
    try {
      const drip = await dripIfLow(input.owner.evmAddress);
      if (drip.kind === "sent") onProgress({ step: "drip", status: "done", txHash: drip.txHash });
      else
        onProgress({
          step: "drip",
          status: "skipped",
          reason: drip.kind === "disabled" ? "drip disabled" : "owner already has Sepolia ETH",
        });
    } catch (error) {
      logError("ens", `owner drip for ${ensName} failed`, error);
      onProgress({
        step: "drip",
        status: "failed",
        message: error instanceof Error ? error.message : "drip failed",
      });
    }
  }
  return {
    agentId,
    ensName,
    registerTx: registration.txHash,
    resolver: registration.resolver,
    hederaAccount: account.accountId,
  };
}
