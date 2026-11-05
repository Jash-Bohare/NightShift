// Hedera testnet operator client (pays account creation, HCS and payout fees).
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { env } from "../config.js";

export const operatorId = AccountId.fromString(env.HEDERA_OPERATOR_ID);
export const operatorKey = PrivateKey.fromStringECDSA(env.HEDERA_OPERATOR_KEY);

export const hedera = Client.forTestnet()
  .setOperator(operatorId, operatorKey)
  .setRequestTimeout(30_000);

/** "0.0.9185802@1792684055.774879732" -> HashScan transaction URL. */
export function hashscanTx(txId: string): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(txId);
  const path = m ? `${m[1]}-${m[2]}-${m[3]}` : txId;
  return `https://hashscan.io/testnet/transaction/${path}`;
}
