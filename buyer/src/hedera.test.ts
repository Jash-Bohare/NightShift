import { describe, expect, it, vi } from "vitest";
import { HederaMirrorClient, transactionIdForMirror } from "./hedera.js";

const expected = {
  transactionId: "0.0.100@123456789.000000001",
  buyerAccountId: "0.0.100",
  payTo: "0.0.200",
  asset: "0.0.429274",
  network: "hedera:testnet",
  amountAtomic: 30_000n,
};
const mirrorTransaction = {
  transactions: [
    {
      transaction_id: "0.0.100-123456789-000000001",
      result: "SUCCESS",
      token_transfers: [
        { token_id: "0.0.429274", account: "0.0.100", amount: -30_000 },
        { token_id: "0.0.429274", account: "0.0.200", amount: 30_000 },
      ],
    },
  ],
};

describe("Hedera Mirror verification", () => {
  it("normalizes transaction ids and checks exact USDC debit and credit", async () => {
    expect(transactionIdForMirror(expected.transactionId)).toBe("0.0.100-123456789-000000001");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(mirrorTransaction)));
    const client = new HederaMirrorClient("https://mirror.example", fetcher, async () => {});
    await expect(client.verifyPayment(expected)).resolves.toMatchObject({ verified: true });
  });

  it("rejects unsuccessful receipts, transaction mismatches, and wrong token amounts", async () => {
    const wrongAmount = structuredClone(mirrorTransaction);
    wrongAmount.transactions[0]!.token_transfers[0]!.amount = -29_999;
    const client = new HederaMirrorClient(
      "https://mirror.example",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(wrongAmount))),
      async () => {},
    );
    await expect(client.verifyPayment(expected)).resolves.toMatchObject({ verified: false });

    await expect(
      client.verifyPayment({ ...expected, transactionId: "invalid" }),
    ).resolves.toMatchObject({ verified: false, reason: expect.stringMatching(/invalid/) });
  });

  it("retries mirror 404 responses and fails closed at the timeout", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(mirrorTransaction)));
    const client = new HederaMirrorClient("https://mirror.example", fetcher, async () => {});
    await expect(client.verifyPayment(expected, 2)).resolves.toMatchObject({ verified: true });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const unavailable = new HederaMirrorClient(
      "https://mirror.example",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 })),
      async () => {},
    );
    await expect(unavailable.verifyPayment(expected, 1)).resolves.toMatchObject({
      verified: false,
      reason: expect.stringMatching(/did not confirm/),
    });
  });

  it("parses a missing buyer token balance as zero", async () => {
    const client = new HederaMirrorClient(
      "https://mirror.example",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            account: "0.0.100",
            balance: { tokens: [] },
          }),
        ),
      ),
    );
    await expect(client.usdcBalance("0.0.100", "0.0.429274")).resolves.toBe(0n);
  });
});
