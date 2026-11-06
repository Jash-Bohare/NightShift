import { z } from "zod";
import type { BuyerConfig } from "./config.js";

const AccountResponse = z.object({
  account: z.string().regex(/^0\.0\.\d+$/),
  balance: z.object({
    tokens: z.array(
      z.object({
        token_id: z.string().regex(/^0\.0\.\d+$/),
        balance: z.number().int().safe().nonnegative(),
      }),
    ),
  }),
});

const TransactionResponse = z.object({
  transactions: z.array(
    z.object({
      transaction_id: z.string(),
      result: z.string(),
      token_transfers: z.array(
        z.object({
          token_id: z.string(),
          account: z.string(),
          amount: z.number().int().safe(),
        }),
      ),
    }),
  ),
});

export interface PaymentExpectation {
  transactionId: string;
  buyerAccountId: string;
  payTo: string;
  asset: string;
  network: string;
  amountAtomic: bigint;
}

export type PaymentIntent = Omit<PaymentExpectation, "transactionId">;

export interface PaymentVerification {
  verified: boolean;
  transactionId: string;
  reason?: string;
}

export function transactionIdForMirror(transactionId: string): string | null {
  const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(transactionId);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function verifyTransactionTransfers(
  transaction: z.infer<typeof TransactionResponse>["transactions"][number],
  expected: PaymentExpectation,
): string | null {
  const normalized = transactionIdForMirror(expected.transactionId);
  if (!normalized || transaction.transaction_id !== normalized)
    return "mirror-node transaction id does not match x402 settlement receipt";
  if (transaction.result !== "SUCCESS") return `Hedera transaction result is ${transaction.result}`;
  const transfers = transaction.token_transfers.filter(
    (transfer) => transfer.token_id === expected.asset,
  );
  const paidByBuyer = transfers
    .filter((transfer) => transfer.account === expected.buyerAccountId)
    .reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
  const receivedByWorker = transfers
    .filter((transfer) => transfer.account === expected.payTo)
    .reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
  if (paidByBuyer !== -expected.amountAtomic)
    return "on-chain debit does not match the expected buyer and exact USDC amount";
  if (receivedByWorker !== expected.amountAtomic)
    return "on-chain credit does not match the ENS pay-to and exact USDC amount";
  return null;
}

export class HederaMirrorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly pause: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async usdcBalance(accountId: string, tokenId: string): Promise<bigint> {
    const url = `${this.baseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}`;
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Hedera account lookup returned HTTP ${response.status}`);
    const parsed = AccountResponse.safeParse(await response.json());
    if (!parsed.success || parsed.data.account !== accountId)
      throw new Error("Hedera mirror returned an invalid buyer account response");
    const token = parsed.data.balance.tokens.find((item) => item.token_id === tokenId);
    return BigInt(token?.balance ?? 0);
  }

  async verifyPayment(expected: PaymentExpectation, attempts = 6): Promise<PaymentVerification> {
    const mirrorId = transactionIdForMirror(expected.transactionId);
    if (!mirrorId)
      return {
        verified: false,
        transactionId: expected.transactionId,
        reason: "invalid Hedera transaction id",
      };
    for (let attempt = 0; attempt < attempts; attempt++) {
      const url = `${this.baseUrl}/api/v1/transactions/${encodeURIComponent(mirrorId)}`;
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const parsed = TransactionResponse.safeParse(await response.json());
        if (!parsed.success)
          return {
            verified: false,
            transactionId: expected.transactionId,
            reason: "Hedera mirror returned an invalid transaction response",
          };
        const transaction = parsed.data.transactions[0];
        if (transaction) {
          const reason = verifyTransactionTransfers(transaction, expected);
          return {
            verified: reason === null,
            transactionId: expected.transactionId,
            ...(reason ? { reason } : {}),
          };
        }
      } else if (response.status !== 404 && response.status !== 429 && response.status < 500) {
        return {
          verified: false,
          transactionId: expected.transactionId,
          reason: `Hedera mirror lookup returned HTTP ${response.status}`,
        };
      }
      if (attempt + 1 < attempts) await this.pause(1_000 * (attempt + 1));
    }
    return {
      verified: false,
      transactionId: expected.transactionId,
      reason: "Hedera mirror did not confirm the transaction before the verification timeout",
    };
  }
}

export function mirrorClient(config: BuyerConfig): HederaMirrorClient {
  return new HederaMirrorClient(config.mirrorUrl);
}
