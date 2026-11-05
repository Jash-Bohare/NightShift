// P0.3 spike: accounts, USDC association, HCS topic round trip on Hedera testnet.
// Run: pnpm -C scripts exec tsx spikes/hedera.ts
// Idempotent: accounts/topic already in .env are reused. New keys go to .env, never stdout.
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import { HEDERA_TESTNET_USDC } from "@x402/hedera";
import { need, optional, upsertEnv } from "../env.js";
import { hashscan, mirrorRetry, txIdForUrl } from "../hedera-util.js";

const operatorId = AccountId.fromString(need("HEDERA_OPERATOR_ID"));
const operatorKey = PrivateKey.fromStringECDSA(need("HEDERA_OPERATOR_KEY"));
const client = Client.forTestnet().setOperator(operatorId, operatorKey);

// Creates an ECDSA account with unlimited auto-associations unless idVar is already set.
async function ensureAccount(
  idVar: string,
  keyVar: string,
  label: string,
  hbar: number,
): Promise<string> {
  const existing = optional(idVar);
  if (existing) {
    console.log(`[hedera] ${label}: reusing ${existing}`);
    return existing;
  }
  const key = PrivateKey.generateECDSA();
  const resp = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(hbar))
    .setMaxAutomaticTokenAssociations(-1)
    .setAccountMemo(`nightshift ${label}`)
    .execute(client);
  const receipt = await resp.getReceipt(client);
  const id = receipt.accountId!.toString();
  upsertEnv(idVar, id);
  upsertEnv(keyVar, `0x${key.toStringRaw()}`);
  console.log(
    `[hedera] ${label}: created ${id}  ${hashscan("transaction", txIdForUrl(resp.transactionId.toString()))}`,
  );
  return id;
}

async function associateUsdc(accountId: string, keyHex: string, label: string): Promise<void> {
  const { tokens } = await mirrorRetry<{ tokens: { token_id: string }[] }>(
    `/accounts/${accountId}/tokens?token.id=${HEDERA_TESTNET_USDC}`,
  );
  if (tokens.length > 0) {
    console.log(`[hedera] ${label}: already associated with USDC ${HEDERA_TESTNET_USDC}`);
    return;
  }
  const tx = await new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(accountId))
    .setTokenIds([TokenId.fromString(HEDERA_TESTNET_USDC)])
    .freezeWith(client)
    .sign(PrivateKey.fromStringECDSA(keyHex));
  const resp = await tx.execute(client);
  const receipt = await resp.getReceipt(client);
  console.log(
    `[hedera] ${label}: associate USDC -> ${receipt.status.toString()}  ${hashscan("transaction", txIdForUrl(resp.transactionId.toString()))}`,
  );
}

async function main() {
  console.log(`[hedera] operator ${operatorId.toString()}`);

  // Buyer pays x402 requests; seller is the spike's payTo; treasury takes the 10% cut later.
  const buyer = await ensureAccount(
    "BUYER_HEDERA_ACCOUNT_ID",
    "BUYER_HEDERA_PRIVATE_KEY",
    "buyer",
    5,
  );
  const seller = await ensureAccount(
    "SPIKE_SELLER_ACCOUNT_ID",
    "SPIKE_SELLER_PRIVATE_KEY",
    "spike seller",
    2,
  );
  const treasury = await ensureAccount(
    "TREASURY_ACCOUNT_ID",
    "TREASURY_PRIVATE_KEY",
    "treasury",
    2,
  );

  // Buyer: explicit association (faucet.circle.com requires it).
  // Seller: deliberately left on auto-association (-1) so P0.4's settle proves -1 works.
  await associateUsdc(buyer, need("BUYER_HEDERA_PRIVATE_KEY"), "buyer");

  for (const [label, id] of [
    ["buyer", buyer],
    ["spike seller", seller],
    ["treasury", treasury],
  ] as const) {
    const acct = await mirrorRetry<{
      max_automatic_token_associations: number;
      balance: { balance: number; tokens: { token_id: string; balance: number }[] };
    }>(`/accounts/${id}`);
    const usdc = acct.balance.tokens.find((t) => t.token_id === HEDERA_TESTNET_USDC);
    console.log(
      `[hedera] ${label} ${id}: maxAutoAssoc=${acct.max_automatic_token_associations} hbar=${acct.balance.balance / 1e8} usdc=${usdc ? usdc.balance / 1e6 : "not associated"}  ${hashscan("account", id)}`,
    );
  }

  // HCS: topic with the operator as submit key, so only Nightshift can write the audit log.
  let topicId = optional("HEDERA_HCS_TOPIC_ID");
  if (!topicId) {
    const resp = await new TopicCreateTransaction()
      .setTopicMemo("nightshift-jobs-v1")
      .setSubmitKey(operatorKey.publicKey)
      .execute(client);
    topicId = (await resp.getReceipt(client)).topicId!.toString();
    upsertEnv("HEDERA_HCS_TOPIC_ID", topicId);
    console.log(`[hedera] topic created ${topicId}  ${hashscan("topic", topicId)}`);
  } else {
    console.log(`[hedera] topic reusing ${topicId}`);
  }

  const message = JSON.stringify({ v: 1, kind: "spike", at: new Date().toISOString() });
  const submit = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .execute(client);
  const seq = (await submit.getReceipt(client)).topicSequenceNumber!.toString();
  console.log(
    `[hedera] submitted seq=${seq}  ${hashscan("transaction", txIdForUrl(submit.transactionId.toString()))}`,
  );

  const readBack = await mirrorRetry<{ message: string; consensus_timestamp: string }>(
    `/topics/${topicId}/messages/${seq}`,
  );
  console.log(
    `[hedera] mirror read seq=${seq} @${readBack.consensus_timestamp}: ${Buffer.from(readBack.message, "base64").toString()}`,
  );

  client.close();
}

main().catch((err) => {
  console.error("[hedera] spike failed:", err);
  client.close();
  process.exit(1);
});
