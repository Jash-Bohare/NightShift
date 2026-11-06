export function hashscanTxUrl(transactionId: string): string | null {
  const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(transactionId);
  if (!match) return null;
  return `https://hashscan.io/testnet/transaction/${match[1]}-${match[2]}-${match[3]}`;
}
