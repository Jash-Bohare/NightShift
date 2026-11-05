// Launch an agent (flow F1, docs/02): validate -> test 0G key -> Hedera account -> rows + encrypted
// secrets -> registerAgent on Sepolia -> active. Shared by scripts/create-agent-cli.ts and POST /me/agents.
import { ENS_PARENT_NAME, SKILL_IDS, type SkillId } from "@nightshift/shared";
import type { Address } from "viem";
import { env } from "../config.js";
import { encrypt } from "../crypto.js";
import { db } from "../db/client.js";
import { ApiError, UpstreamError } from "../errors.js";
import { available, isValidLabel, registerAgent, etherscanTx } from "../ens/registrar.js";
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
}

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

export async function launchAgent(input: LaunchInput): Promise<LaunchResult> {
  const { label } = input;
  if (!SKILL_IDS.includes(input.skill))
    throw new ApiError(422, "invalid_input", `unknown skill ${input.skill}`);
  const skill = getSkill(input.skill)!;
  if (!(await isValidLabel(label)))
    throw new ApiError(422, "invalid_label", "label must be 3–32 chars of a-z, 0-9, -");
  if (!(await available(label)))
    throw new ApiError(409, "label_taken", `${label}.${ENS_PARENT_NAME} is taken`);
  const existing = await db.from("agents").select("id,status").eq("label", label).maybeSingle();
  if (existing.data)
    throw new ApiError(
      409,
      "label_taken",
      `label ${label} already has a row (${existing.data.status})`,
    );

  // 1-token call proves the sk- key works and has credit (costs a few micro-USD).
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

  const ensName = `${label}.${ENS_PARENT_NAME}`;
  const account = await createAgentAccount(`nightshift ${ensName}`);
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
      hedera_account_id: account.accountId,
    })
    .select("id")
    .single();
  if (ins.error) throw new UpstreamError("db", `insert agent: ${ins.error.message}`);
  const agentId = (ins.data as { id: string }).id;

  const sec = await db.from("agent_secrets").insert({
    agent_id: agentId,
    zg_api_key_enc: encrypt(input.zgApiKey, env.SECRETS_MASTER_KEY),
    zg_mgmt_key_enc: input.zgMgmtKey ? encrypt(input.zgMgmtKey, env.SECRETS_MASTER_KEY) : null,
    hedera_private_key_enc: encrypt(account.privateKeyHex, env.SECRETS_MASTER_KEY),
  });
  if (sec.error) throw new UpstreamError("db", `insert secrets: ${sec.error.message}`);

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
    });
    const reg = await registerAgent(label, input.owner.evmAddress, records);
    const upd = await db
      .from("agents")
      .update({
        status: "active",
        resolver_address: reg.resolver,
        register_tx: reg.txHash,
        expiry: reg.expiry.toISOString(),
      })
      .eq("id", agentId);
    if (upd.error) throw new UpstreamError("db", `activate agent: ${upd.error.message}`);
    log("server", "agent launched", {
      ensName,
      agentId,
      hedera: account.accountId,
      tx: etherscanTx(reg.txHash),
    });
    return {
      agentId,
      ensName,
      registerTx: reg.txHash,
      resolver: reg.resolver,
      hederaAccount: account.accountId,
    };
  } catch (err) {
    logError("ens", `launch of ${ensName} failed; agent row marked failed`, err);
    await db.from("agents").update({ status: "failed" }).eq("id", agentId);
    throw err;
  }
}
