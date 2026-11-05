// NightshiftRegistrar client on Sepolia (operator hot key). Writes: registerAgent, setReputation.
import { nightshiftRegistrarAbi } from "@nightshift/shared";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { deployment, env } from "../config.js";
import { UpstreamError } from "../errors.js";
import { log } from "../log.js";

const transport = http(env.SEPOLIA_RPC_URL, { timeout: 30_000, retryCount: 2 });
export const sepoliaClient = createPublicClient({ chain: sepolia, transport });
const operator = privateKeyToAccount(env.ENS_OPERATOR_PRIVATE_KEY as `0x${string}`);
const wallet = createWalletClient({ chain: sepolia, transport, account: operator });

const registrar = {
  address: deployment.nightshiftRegistrar as Address,
  abi: nightshiftRegistrarAbi,
} as const;

export const etherscanTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

async function wrap<T>(what: string, p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    const msg =
      err instanceof Error
        ? ((err as { shortMessage?: string }).shortMessage ?? err.message)
        : String(err);
    throw new UpstreamError("ens", `${what}: ${msg}`);
  }
}

export function available(label: string): Promise<boolean> {
  return wrap(
    "available",
    sepoliaClient.readContract({ ...registrar, functionName: "available", args: [label] }),
  );
}

export function isValidLabel(label: string): Promise<boolean> {
  return wrap(
    "isValidLabel",
    sepoliaClient.readContract({ ...registrar, functionName: "isValidLabel", args: [label] }),
  );
}

export interface Registered {
  txHash: Hash;
  resolver: Address;
  tokenId: bigint;
  expiry: Date;
}

export async function registerAgent(
  label: string,
  owner: Address,
  records: { key: string; value: string }[],
): Promise<Registered> {
  // Simulate first so a revert (NameTaken, KeyNotAllowed, …) surfaces before spending gas.
  const { request } = await wrap(
    "registerAgent simulate",
    sepoliaClient.simulateContract({
      ...registrar,
      account: operator,
      functionName: "registerAgent",
      args: [label, owner, records],
    }),
  );
  const txHash = await wrap("registerAgent send", wallet.writeContract(request));
  log("ens", "registerAgent sent", { label, tx: etherscanTx(txHash) });
  const receipt = await wrap(
    "registerAgent receipt",
    sepoliaClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 }),
  );
  if (receipt.status !== "success")
    throw new UpstreamError("ens", `registerAgent reverted: ${etherscanTx(txHash)}`);
  const [ev] = parseEventLogs({
    abi: nightshiftRegistrarAbi,
    eventName: "AgentRegistered",
    logs: receipt.logs,
  });
  if (!ev) throw new UpstreamError("ens", `no AgentRegistered event in ${txHash}`);
  log("ens", "agent registered", {
    label,
    resolver: ev.args.resolver,
    gas: receipt.gasUsed.toString(),
  });
  return {
    txHash,
    resolver: ev.args.resolver,
    tokenId: ev.args.tokenId,
    expiry: new Date(Number(ev.args.expiry) * 1000),
  };
}

export async function setReputation(label: string, json: string): Promise<Hash> {
  const { request } = await wrap(
    "setReputation simulate",
    sepoliaClient.simulateContract({
      ...registrar,
      account: operator,
      functionName: "setReputation",
      args: [label, json],
    }),
  );
  const txHash = await wrap("setReputation send", wallet.writeContract(request));
  const receipt = await wrap(
    "setReputation receipt",
    sepoliaClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 }),
  );
  if (receipt.status !== "success")
    throw new UpstreamError("ens", `setReputation reverted: ${etherscanTx(txHash)}`);
  log("ens", "reputation written", { label, json, tx: etherscanTx(txHash) });
  return txHash;
}
