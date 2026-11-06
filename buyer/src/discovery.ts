import { nightshiftRegistrarAbi, userRegistryAbi, type BuyerRules } from "@nightshift/shared";
import { z } from "zod";
import {
  createPublicClient,
  http,
  isAddress,
  isAddressEqual,
  labelhash,
  zeroAddress,
  type Address,
} from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import type { BuyerPublicConfig } from "./config.js";
import {
  isValidPayTo,
  nameAllowed,
  parseEnsPrice,
  parseReputation,
  type VerifiedAgent,
} from "./decide.js";

const Label = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/);
const DirectoryAgent = z.object({
  label: Label,
  ensName: z.string().min(1).max(255),
  owner: z.string().refine(isAddress),
  resolver: z.string().refine(isAddress),
  skill: z.string().nullable(),
  price: z.object({ amount: z.string().regex(/^\d+$/).nullable() }),
  reputation: z
    .object({
      jobs: z.number().nonnegative().optional(),
      success: z.number().min(0).max(1).optional(),
      p50_ms: z.number().nonnegative().optional(),
    })
    .nullable(),
  status: z.string(),
});
const DirectoryPage = z.object({
  agents: z.array(DirectoryAgent),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
});

export type DirectoryHint = z.infer<typeof DirectoryAgent>;

export interface EnsReader {
  chainId(): Promise<number>;
  registrarRegistry(): Promise<Address>;
  registrarResolver(label: string): Promise<Address>;
  ensResolver(name: string): Promise<Address | null>;
  registryStatus(label: string): Promise<number>;
  registryExpiry(label: string): Promise<bigint>;
  registryOwner(label: string): Promise<Address>;
  text(name: string, key: string): Promise<string | null>;
}

export interface DiscoveryOptions {
  fetcher?: typeof fetch;
  ens?: EnsReader;
  now?: () => number;
  onVerify?: (
    candidate: DirectoryHint,
    result: { ok: true; agent: VerifiedAgent } | { ok: false; reason: string },
  ) => void;
}

const MAX_PAGES = 10;

export function createEnsReader(config: BuyerPublicConfig): EnsReader {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(config.sepoliaRpcUrl, { timeout: 20_000, retryCount: 1 }),
  });
  const registrar = { address: config.registrarAddress, abi: nightshiftRegistrarAbi } as const;
  const registry = { address: config.userRegistryAddress, abi: userRegistryAbi } as const;
  return {
    chainId: () => client.getChainId(),
    registrarRegistry: () => client.readContract({ ...registrar, functionName: "REGISTRY" }),
    registrarResolver: (label) =>
      client.readContract({
        ...registrar,
        functionName: "resolverOf",
        args: [labelhash(label)],
      }),
    ensResolver: async (name) => (await client.getEnsResolver({ name })) ?? null,
    registryStatus: (label) =>
      client.readContract({
        ...registry,
        functionName: "getStatus",
        args: [BigInt(labelhash(label))],
      }),
    registryExpiry: (label) =>
      client.readContract({
        ...registry,
        functionName: "getExpiry",
        args: [BigInt(labelhash(label))],
      }),
    registryOwner: (label) =>
      client.readContract({
        ...registry,
        functionName: "getOwner",
        args: [BigInt(labelhash(label))],
      }),
    text: (name, key) => client.getEnsText({ name, key }),
  };
}

async function getDirectoryPage(
  config: BuyerPublicConfig,
  skill: string,
  page: number,
  fetcher: typeof fetch,
): Promise<z.infer<typeof DirectoryPage>> {
  const url = new URL("/directory", config.serverUrl);
  url.searchParams.set("skill", skill);
  url.searchParams.set("status", "available");
  url.searchParams.set("sort", "price");
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", "100");
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`directory returned HTTP ${response.status}`);
  const parsed = DirectoryPage.safeParse(await response.json());
  if (!parsed.success) throw new Error("directory returned an invalid response");
  if (parsed.data.page !== page || parsed.data.limit > 100)
    throw new Error("directory returned inconsistent pagination metadata");
  return parsed.data;
}

export async function discoverDirectory(
  config: BuyerPublicConfig,
  skill: string,
  options: Pick<DiscoveryOptions, "fetcher"> = {},
): Promise<DirectoryHint[]> {
  const fetcher = options.fetcher ?? fetch;
  const first = await getDirectoryPage(config, skill, 1, fetcher);
  const pages = Math.min(MAX_PAGES, Math.ceil(first.total / first.limit));
  if (first.total > MAX_PAGES * first.limit)
    throw new Error(
      `directory has more than ${MAX_PAGES * first.limit} candidates; refusing an incomplete scan`,
    );
  const all = [...first.agents];
  for (let page = 2; page <= pages; page++) {
    const next = await getDirectoryPage(config, skill, page, fetcher);
    if (next.total !== first.total || next.limit !== first.limit || next.page !== page)
      throw new Error("directory changed while pagination was in progress");
    all.push(...next.agents);
  }
  const unique = new Map<string, DirectoryHint>();
  for (const candidate of all) {
    if (candidate.skill === skill && ["active", "paused_budget"].includes(candidate.status))
      unique.set(candidate.label, candidate);
  }
  return [...unique.values()];
}

export function validateWorkerEndpoint(
  endpoint: string,
  serverUrl: string,
  label: string,
): string | null {
  try {
    const target = new URL(endpoint);
    const server = new URL(serverUrl);
    if (target.username || target.password || target.search || target.hash)
      return "worker endpoint contains credentials, query, or fragment";
    if (target.protocol !== "https:" && target.protocol !== "http:")
      return "worker endpoint must use HTTP or HTTPS";
    if (target.origin !== server.origin)
      return "worker endpoint origin does not match the configured Nightshift server";
    if (target.pathname !== `/a/${encodeURIComponent(label)}/run`)
      return "worker endpoint path does not match its registered label";
    return null;
  } catch {
    return "worker endpoint is not a valid URL";
  }
}

export async function verifyDirectoryCandidates(
  config: BuyerPublicConfig,
  candidates: DirectoryHint[],
  requestedSkill: string,
  rules: BuyerRules,
  options: DiscoveryOptions = {},
): Promise<VerifiedAgent[]> {
  const ens = options.ens ?? createEnsReader(config);
  const now = options.now ?? Date.now;
  const verified: VerifiedAgent[] = [];

  if ((await ens.chainId()) !== 11155111)
    throw new Error("ENS verification RPC is not connected to Sepolia (chain id 11155111)");
  if (!isAddressEqual(await ens.registrarRegistry(), config.userRegistryAddress))
    throw new Error("configured user registry does not match the NightshiftRegistrar registry");

  for (const candidate of candidates) {
    const reject = (reason: string) => options.onVerify?.(candidate, { ok: false, reason });
    try {
      if (!nameAllowed(candidate.label, candidate.ensName, rules.allowParentNames)) {
        reject("ENS name is outside the configured Nightshift namespace");
        continue;
      }
      if (candidate.skill !== requestedSkill) {
        reject("directory skill does not match the requested skill");
        continue;
      }
      const name = normalize(candidate.ensName);
      if (name.toLowerCase() !== candidate.ensName.toLowerCase()) {
        reject("ENS name is not normalized");
        continue;
      }
      const [registrarResolver, resolver, status, expiry, owner] = await Promise.all([
        ens.registrarResolver(candidate.label),
        ens.ensResolver(name),
        ens.registryStatus(candidate.label),
        ens.registryExpiry(candidate.label),
        ens.registryOwner(candidate.label),
      ]);
      if (
        registrarResolver === zeroAddress ||
        !resolver ||
        !isAddressEqual(resolver, registrarResolver) ||
        !isAddressEqual(candidate.resolver as Address, registrarResolver)
      ) {
        reject("ENS resolver does not match the NightshiftRegistrar record");
        continue;
      }
      if (status !== 2) {
        reject(`ENS registry status is not REGISTERED (${status})`);
        continue;
      }
      if (expiry <= BigInt(Math.floor(now() / 1000))) {
        reject("ENS registration has expired");
        continue;
      }
      if (owner === zeroAddress || !isAddressEqual(owner, candidate.owner as Address)) {
        reject("ENS registry owner does not match the directory identity");
        continue;
      }

      const [skill, priceText, payTo, endpoint, reputationText] = await Promise.all([
        ens.text(name, "nightshift.skill"),
        ens.text(name, "nightshift.price"),
        ens.text(name, "nightshift.payto"),
        ens.text(name, "agent-endpoint[x402]"),
        ens.text(name, "nightshift.reputation"),
      ]);
      const price = parseEnsPrice(priceText);
      const reputation = parseReputation(reputationText);
      const endpointProblem = endpoint
        ? validateWorkerEndpoint(endpoint, config.serverUrl, candidate.label)
        : "ENS x402 endpoint is missing";
      if (skill !== candidate.skill || !skill)
        reject("ENS skill does not match the requested directory skill");
      else if (!price || price.amount <= 0n) reject("ENS price is missing, malformed, or zero");
      else if (!isValidPayTo(payTo)) reject("ENS pay-to is not a valid Hedera account id");
      else if (endpointProblem) reject(endpointProblem);
      else if (!reputation) reject("ENS reputation is missing or malformed");
      else {
        const agent: VerifiedAgent = {
          label: candidate.label,
          ensName: name,
          skill,
          price,
          payTo,
          endpoint: endpoint!,
          reputation,
          expiry: expiry.toString(),
          owner,
          resolver: registrarResolver,
        };
        verified.push(agent);
        options.onVerify?.(candidate, { ok: true, agent });
      }
    } catch (error) {
      reject(
        error instanceof Error
          ? `ENS verification failed: ${error.message}`
          : "ENS verification failed",
      );
    }
  }
  return verified;
}
