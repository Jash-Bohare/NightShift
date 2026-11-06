import { HEDERA_NETWORK, type BuyerRules } from "@nightshift/shared";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { SchemeNetworkClient } from "@x402/core/types";
import { filterRequirements } from "./decide.js";
import type { BuyerConfig } from "./config.js";
import type { PaymentIntent } from "./hedera.js";

export function paymentReadinessError(balance: bigint, amount: bigint): string | null {
  if (amount <= 0n) return "payment amount must be positive";
  if (balance < amount)
    return `insufficient USDC balance: have ${balance} atomic units, need ${amount}`;
  return null;
}

/**
 * x402 fetch with the buyer's spend controls and exact-requirements policy. `scheme` defaults to
 * the real Hedera signer; the simulated end-to-end test injects a non-signing scheme so the same
 * client, policy and caps are exercised without creating a Hedera transaction.
 */
export function createX402Fetch(
  config: BuyerConfig,
  rules: BuyerRules,
  expected: PaymentIntent,
  scheme?: SchemeNetworkClient,
): typeof fetch {
  const client = new x402Client()
    .register(
      HEDERA_NETWORK,
      scheme ??
        new ExactHederaScheme(
          createClientHederaSigner(
            config.buyerAccountId,
            PrivateKey.fromStringECDSA(config.buyerPrivateKey),
            { network: HEDERA_NETWORK },
          ),
        ),
    )
    .setSpendControls({
      allowedAssets: rules.allowedNetworks.flatMap((network) =>
        rules.allowedAssets.map((asset) => ({
          network: network as `${string}:${string}`,
          asset,
          maxAmountPerPayment: rules.maxPerJobAtomic,
        })),
      ),
    })
    .registerPolicy((_version, requirements) =>
      filterRequirements(
        requirements,
        {
          payTo: expected.payTo,
          asset: expected.asset,
          network: expected.network,
          amount: expected.amountAtomic,
        },
        rules,
      ),
    );
  return wrapFetchWithPayment(fetch, client);
}

export function readPaymentResponse(header: string): {
  success: boolean;
  transaction: string;
} {
  const response = decodePaymentResponseHeader(header);
  if (
    typeof response.success !== "boolean" ||
    typeof response.transaction !== "string" ||
    response.transaction.length === 0
  )
    throw new Error("x402 payment response is malformed");
  return { success: response.success, transaction: response.transaction };
}
