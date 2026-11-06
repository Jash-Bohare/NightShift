import {
  createPublicClient,
  http,
  isAddress,
  keccak256,
  stringToBytes,
  type Address,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { nightshiftRegistrarAbi } from "@nightshift/shared/registrarAbi";
import { publicEnv } from "./public-env";

export const NIGHTSHIFT_REGISTRAR = "0x9564fFd96FBaA1bF10836966990aCc88a9865705" as Address;

let sepoliaClient: PublicClient | null = null;

export function getSepoliaClient(): PublicClient {
  if (!publicEnv.sepoliaRpcUrl) throw new Error("NEXT_PUBLIC_SEPOLIA_RPC_URL is not configured.");
  if (!sepoliaClient) {
    sepoliaClient = createPublicClient({
      chain: sepolia,
      transport: http(publicEnv.sepoliaRpcUrl, { timeout: 10_000 }),
    });
  }
  return sepoliaClient;
}

export async function readRegistrarResolver(label: string): Promise<Address> {
  const address = publicEnv.registrarAddress;
  if (!isAddress(address)) throw new Error("The Sepolia registrar address is invalid.");
  return getSepoliaClient().readContract({
    address,
    abi: nightshiftRegistrarAbi,
    functionName: "resolverOf",
    args: [keccak256(stringToBytes(label))],
  });
}

export async function checkRegistrarAvailable(label: string): Promise<boolean> {
  const address = publicEnv.registrarAddress;
  if (!isAddress(address)) throw new Error("The Sepolia registrar address is invalid.");
  return getSepoliaClient().readContract({
    address,
    abi: nightshiftRegistrarAbi,
    functionName: "available",
    args: [label],
  });
}
