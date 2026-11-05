// Create an agent's Hedera account: ECDSA key, unlimited auto-associations (receives USDC
// without an associate tx, verified P0.3), small HBAR float for the payout transfer fee.
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { UpstreamError, withTimeout } from "../errors.js";
import { log } from "../log.js";
import { hedera } from "./client.js";

export interface NewAccount {
  accountId: string;
  /** 0x-prefixed raw ECDSA key. Encrypt before storing; never log. */
  privateKeyHex: string;
}

export async function createAgentAccount(memo: string): Promise<NewAccount> {
  const key = PrivateKey.generateECDSA();
  const receipt = await withTimeout(
    "hedera",
    "account create",
    45_000,
    (async () => {
      const resp = await new AccountCreateTransaction()
        .setKeyWithoutAlias(key.publicKey)
        .setInitialBalance(new Hbar(2))
        .setMaxAutomaticTokenAssociations(-1)
        .setAccountMemo(memo.slice(0, 100))
        .execute(hedera);
      return resp.getReceipt(hedera);
    })(),
  );
  if (!receipt.accountId)
    throw new UpstreamError("hedera", "account create receipt without accountId");
  const accountId = receipt.accountId.toString();
  log("hedera", "agent account created", {
    accountId,
    url: `https://hashscan.io/testnet/account/${accountId}`,
  });
  return { accountId, privateKeyHex: `0x${key.toStringRaw()}` };
}
