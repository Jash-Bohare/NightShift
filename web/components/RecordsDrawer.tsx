"use client";

// Owner record edit drawer (docs/06 /dashboard "Edit records", user story O5): the owner's own
// wallet signs the ENS setText on the worker's PermissionedResolver. Nightshift never signs it.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallets } from "@privy-io/react-auth";
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { formatUsdc } from "@nightshift/shared/money";
import { Button } from "./ui/Button";
import { ErrorPanel, ExternalLink, LoadingPanel } from "./Product";
import { serverGet, serverSend, type AgentProfile } from "../lib/api";
import { getSepoliaClient } from "../lib/chain";
import { etherscanTransactionUrl } from "../lib/explorers";
import { atomicFromDecimal, decimalFromAtomic } from "../lib/launch";
import type { OwnerAgent } from "../lib/owner";

const resolverAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function multicall(bytes[] calls) returns (bytes[] results)",
]);

interface Draft {
  ensName: string;
  dnsName: Hex;
  resolver: string;
  signer: string;
  records: { key: string; value: string }[];
}

type Phase =
  | { kind: "form" }
  | { kind: "drafting" }
  | { kind: "signing" }
  | { kind: "confirming"; txHash: Hex }
  | { kind: "syncing"; txHash: Hex }
  | { kind: "done"; txHash: Hex; priceAtomic: string; directorySynced: boolean }
  | { kind: "error"; message: string; txHash?: Hex };

/** Human message for a wallet/RPC failure. */
function walletError(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string; code?: number };
  const text = e?.shortMessage ?? e?.message ?? "The transaction failed.";
  if (e?.code === 4001 || /reject|denied/i.test(text))
    return "You declined the signature. Nothing was written.";
  if (/insufficient funds/i.test(text))
    return "Your wallet has no Sepolia ETH for gas. Get some from a Sepolia faucet and try again.";
  return text;
}

export function RecordsDrawer({
  agent,
  ownerAddress,
  getToken,
  onClose,
}: {
  agent: OwnerAgent;
  ownerAddress: string;
  getToken: () => Promise<string | null>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { wallets, ready } = useWallets();
  const profile = useQuery({
    queryKey: ["agent-profile", agent.label],
    queryFn: ({ signal }) =>
      serverGet<AgentProfile>(`/agents/${encodeURIComponent(agent.label)}`, signal),
    retry: 1,
  });
  const currentDescription = profile.data?.ens?.description ?? profile.data?.description ?? "";
  const [price, setPrice] = useState(decimalFromAtomic(BigInt(agent.priceAtomic)));
  const [description, setDescription] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const descriptionValue = description ?? currentDescription;
  const priceAtomic = atomicFromDecimal(price);
  const priceValid = priceAtomic !== null && priceAtomic > 0n && priceAtomic <= 10_000_000n;
  const priceChanged = priceValid && priceAtomic!.toString() !== agent.priceAtomic;
  const descriptionChanged =
    descriptionValue.trim().length > 0 && descriptionValue.trim() !== currentDescription.trim();
  const busy = ["drafting", "signing", "confirming", "syncing"].includes(phase.kind);

  async function save() {
    if (busy || (!priceChanged && !descriptionChanged)) return;
    let txHash: Hex | undefined;
    try {
      setPhase({ kind: "drafting" });
      const token = await getToken();
      if (!token) throw new Error("Privy did not provide an access token. Sign in again.");
      const draft = await serverSend<Draft>(
        `/me/agents/${encodeURIComponent(agent.id)}/records/draft`,
        {
          method: "POST",
          bearerToken: token,
          body: {
            ...(priceChanged ? { priceAtomic: priceAtomic!.toString() } : {}),
            ...(descriptionChanged ? { description: descriptionValue.trim() } : {}),
          },
        },
      );
      if (!isAddress(draft.resolver) || !isAddress(draft.signer) || draft.records.length === 0)
        throw new Error("The server returned an invalid record draft.");
      const wallet = wallets.find((w) => w.address.toLowerCase() === draft.signer.toLowerCase());
      if (!wallet)
        throw new Error(
          `This name is owned by ${draft.signer}. Sign in with that wallet to edit its records.`,
        );

      setPhase({ kind: "signing" });
      await wallet.switchChain(sepolia.id);
      const provider = await wallet.getEthereumProvider();
      const client = createWalletClient({
        account: getAddress(draft.signer),
        chain: sepolia,
        transport: custom(provider),
      });
      const calls = draft.records.map((r) =>
        encodeFunctionData({
          abi: resolverAbi,
          functionName: "setText",
          args: [draft.dnsName, r.key, r.value],
        }),
      );
      // One signature for all edits: the resolver's multicall delegatecalls itself, so the
      // owner's per-key setText roles still apply to every call.
      txHash = await client.sendTransaction({
        to: getAddress(draft.resolver),
        data:
          calls.length === 1
            ? calls[0]!
            : encodeFunctionData({ abi: resolverAbi, functionName: "multicall", args: [calls] }),
      });

      setPhase({ kind: "confirming", txHash });
      const receipt = await getSepoliaClient().waitForTransactionReceipt({
        hash: txHash,
        timeout: 180_000,
      });
      if (receipt.status !== "success") throw new Error("The record update reverted on Sepolia.");

      setPhase({ kind: "syncing", txHash });
      const synced = await serverSend<{ priceAtomic: string; directorySynced: boolean }>(
        `/me/agents/${encodeURIComponent(agent.id)}/records/sync`,
        { method: "POST", bearerToken: token, body: {} },
      );
      setPhase({ kind: "done", txHash, ...synced });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["owner-dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["agent-profile", agent.label] }),
      ]);
    } catch (error) {
      setPhase({ kind: "error", message: walletError(error), ...(txHash ? { txHash } : {}) });
    }
  }

  const txLink = "txHash" in phase && phase.txHash ? etherscanTransactionUrl(phase.txHash) : null;

  return (
    <div className="drawer-backdrop" role="presentation" onClick={busy ? undefined : onClose}>
      <aside
        aria-labelledby="records-drawer-title"
        aria-modal="true"
        className="drawer card hard-shadow"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="kick">Edit records · signed by you</div>
        <h2 className="section-title" id="records-drawer-title">
          {agent.ensName}
        </h2>
        <p className="small-note">
          Changes are ENS text records on this worker’s resolver, signed by your wallet{" "}
          <code className="mono">
            {ownerAddress.slice(0, 6)}…{ownerAddress.slice(-4)}
          </code>
          . Nightshift cannot write them; it can only write <code>nightshift.reputation</code>.
        </p>

        {profile.isPending ? (
          <LoadingPanel label="Reading current records…" />
        ) : (
          <div className="wizard-fields">
            <label className="control-label">
              Price per {agent.priceUnit} (USDC)
              <input
                className="form-control form-control--mono"
                disabled={busy}
                inputMode="decimal"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
              <span className="muted">
                Now {formatUsdc(BigInt(agent.priceAtomic))} USDC. Writes{" "}
                <code>nightshift.price</code> and <code>agent-context</code>.
              </span>
              {!priceValid && (
                <span className="field-error">Use a positive amount up to 10 USDC.</span>
              )}
            </label>
            <label className="control-label">
              Description
              <textarea
                className="form-control"
                disabled={busy}
                maxLength={500}
                rows={3}
                value={descriptionValue}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </div>
        )}
        {profile.isError && (
          <p className="field-error">Current description unavailable: {profile.error.message}</p>
        )}

        <div className="drawer-status" aria-live="polite">
          {phase.kind === "drafting" && <LoadingPanel label="Preparing the record values…" />}
          {phase.kind === "signing" && (
            <LoadingPanel label="Approve the transaction in your wallet (Sepolia)…" />
          )}
          {phase.kind === "confirming" && (
            <LoadingPanel label="Waiting for Sepolia to confirm (~12 s)…" />
          )}
          {phase.kind === "syncing" && <LoadingPanel label="Updating Nightshift from ENS…" />}
          {phase.kind === "done" && (
            <div className="alert-note">
              <strong>Records updated on ENS.</strong>
              <p>
                Price is now {formatUsdc(BigInt(phase.priceAtomic))} USDC per {agent.priceUnit}.
                {phase.directorySynced ? "" : " The directory will catch up on its next refresh."}
              </p>
            </div>
          )}
          {phase.kind === "error" && <ErrorPanel message={phase.message} />}
          {txLink && (
            <p className="mono">
              <ExternalLink href={txLink}>Owner-signed tx on Sepolia ↗</ExternalLink>
            </p>
          )}
        </div>

        <div className="wizard-nav">
          <Button disabled={busy} onClick={onClose}>
            Close
          </Button>
          <Button
            variant="ink"
            disabled={busy || !ready || !priceValid || (!priceChanged && !descriptionChanged)}
            onClick={() => void save()}
          >
            {phase.kind === "done" ? "Save again" : "Sign & save"}
          </Button>
        </div>
      </aside>
    </div>
  );
}
