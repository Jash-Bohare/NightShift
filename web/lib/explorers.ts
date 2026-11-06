const HEDERA_ID = /^0\.0\.\d+$/;
const HEDERA_TRANSACTION = /^(0\.0\.\d+)@(\d+)\.(\d+)$/;
const ETHEREUM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ETHEREUM_TRANSACTION = /^0x[0-9a-fA-F]{64}$/;

export function hashscanAccountUrl(accountId: string): string | null {
  return HEDERA_ID.test(accountId) ? `https://hashscan.io/testnet/account/${accountId}` : null;
}

export function hashscanTopicUrl(topicId: string): string | null {
  return HEDERA_ID.test(topicId) ? `https://hashscan.io/testnet/topic/${topicId}` : null;
}

export function hashscanTransactionUrl(transactionId: string): string | null {
  const match = HEDERA_TRANSACTION.exec(transactionId);
  if (!match) return null;

  return `https://hashscan.io/testnet/transaction/${match[1]}-${match[2]}-${match[3]}`;
}

export function etherscanAddressUrl(address: string): string | null {
  return ETHEREUM_ADDRESS.test(address) ? `https://sepolia.etherscan.io/address/${address}` : null;
}

export function etherscanTransactionUrl(transactionHash: string): string | null {
  return ETHEREUM_TRANSACTION.test(transactionHash)
    ? `https://sepolia.etherscan.io/tx/${transactionHash}`
    : null;
}

export function ensAppUrl(name: string): string {
  return `https://app.ens.dev/${encodeURIComponent(name)}`;
}

/** One HCS message as JSON on the testnet mirror node (docs/07: GET /topics/{id}/messages/{seq}). */
export function hcsMessageUrl(topicId: string, sequence: string): string | null {
  return HEDERA_ID.test(topicId) && /^\d+$/.test(sequence)
    ? `https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages/${sequence}`
    : null;
}
