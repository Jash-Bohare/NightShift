// P0.5 spike: nightshift.eth -> our UserRegistry -> hello.nightshift.eth with its own
// PermissionedResolver, then read agent-context back through the Universal Resolver.
// Run: pnpm -C scripts exec tsx spikes/ens.ts
// Idempotent: addresses already in .env are reused; finished steps are skipped.
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { labelhash, namehash, normalize, packetToBytes } from "viem/ens";
import { need, optional, upsertEnv } from "../env.js";

// Sepolia ENSv2 (docs/07, matches contracts-v2 deployments/sepolia/addresses.md @ 07e55a0).
const ETH_REGISTRY = "0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4";
const VERIFIABLE_FACTORY = "0xda70306c98e97ece36f997a21368e53298572991";
const USER_REGISTRY_IMPL = "0x9bd8a88719068d09ecee662f36c0e3856708366a";
const PERMISSIONED_RESOLVER_IMPL = "0x115eb53f0c60696633855f90b138178fb40b2b2c";

// EACBaseRolesLib.ALL_ROLES: every role and every admin role.
const ALL_ROLES = BigInt("0x" + "1".repeat(64));
const STATUS_REGISTERED = 2;

const PARENT = need("ENS_PARENT_NAME"); // nightshift.eth
const LABEL = "hello";
const NAME = `${LABEL}.${PARENT}`;

const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);
const registryAbi = parseAbi([
  "struct Grant { address account; uint256 roleBitmap; }",
  "struct State { uint8 status; uint64 expiry; address latestOwner; uint256 tokenId; uint256 resource; }",
  "function initialize(Grant[] grants)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function setSubregistry(uint256 anyId, address registry)",
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function getState(uint256 anyId) view returns (State)",
]);
const resolverAbi = parseAbi([
  "struct Grant { address account; uint256 roleBitmap; }",
  "function initialize(Grant[] grants, bytes[] calls)",
  "function setText(bytes name, string key, string value)",
]);

const account = privateKeyToAccount(need("DEPLOYER_PRIVATE_KEY") as Hex);
const transport = http(need("SEPOLIA_RPC_URL"), { timeout: 30_000 });
const pub = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });

const etherscanTx = (hash: Hex) => `https://sepolia.etherscan.io/tx/${hash}`;
const dnsEncode = (name: string) => toHex(packetToBytes(normalize(name)));
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function send(label: string, hash: Hex) {
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success")
    throw new Error(`[ens] ${label} reverted: ${etherscanTx(hash)}`);
  console.log(`[ens] ${label}: gas ${receipt.gasUsed}  ${etherscanTx(hash)}`);
  return receipt;
}

async function deployProxy(
  label: string,
  impl: Address,
  salt: bigint,
  data: Hex,
): Promise<Address> {
  const hash = await wallet.writeContract({
    address: VERIFIABLE_FACTORY,
    abi: factoryAbi,
    functionName: "deployProxy",
    args: [impl, salt, data],
  });
  const receipt = await send(label, hash);
  const [log] = parseEventLogs({ abi: factoryAbi, eventName: "ProxyDeployed", logs: receipt.logs });
  if (!log) throw new Error(`[ens] ${label}: no ProxyDeployed event`);
  return log.args.proxyAddress;
}

async function ensureUserRegistry(): Promise<Address> {
  const existing = optional("ENS_USER_REGISTRY_ADDRESS");
  if (existing) {
    console.log(`[ens] UserRegistry: reusing ${existing}`);
    return existing as Address;
  }
  // Salt scheme from ENS docs: keccak256(abi.encode(keccak256("UserRegistry"), namehash, version)).
  const salt = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [keccak256(stringToBytes("UserRegistry")), namehash(PARENT), 1n],
      ),
    ),
  );
  const data = encodeFunctionData({
    abi: registryAbi,
    functionName: "initialize",
    args: [[{ account: account.address, roleBitmap: ALL_ROLES }]],
  });
  const proxy = await deployProxy("deploy UserRegistry", USER_REGISTRY_IMPL, salt, data);
  upsertEnv("ENS_USER_REGISTRY_ADDRESS", proxy);
  return proxy;
}

async function ensureSubregistry(userRegistry: Address) {
  const parentLabel = PARENT.split(".")[0]!;
  const current = await pub.readContract({
    address: ETH_REGISTRY,
    abi: registryAbi,
    functionName: "getSubregistry",
    args: [parentLabel],
  });
  if (sameAddress(current, userRegistry)) {
    console.log(`[ens] ${PARENT} subregistry already ${userRegistry}`);
    return;
  }
  const hash = await wallet.writeContract({
    address: ETH_REGISTRY,
    abi: registryAbi,
    functionName: "setSubregistry",
    args: [BigInt(labelhash(parentLabel)), userRegistry],
  });
  await send(`setSubregistry(${PARENT})`, hash);
}

async function ensureHello(userRegistry: Address): Promise<Address> {
  const state = await pub.readContract({
    address: userRegistry,
    abi: registryAbi,
    functionName: "getState",
    args: [BigInt(labelhash(LABEL))],
  });
  if (state.status === STATUS_REGISTERED) {
    const resolver = await pub.readContract({
      address: userRegistry,
      abi: registryAbi,
      functionName: "getResolver",
      args: [LABEL],
    });
    console.log(`[ens] ${NAME} already registered, resolver ${resolver}`);
    return resolver;
  }

  // Per-agent resolver; the initial record is written by initialize (role checks skipped there).
  const salt = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [keccak256(stringToBytes("NightshiftAgentResolver")), labelhash(LABEL), 1n],
      ),
    ),
  );
  const initialText = encodeFunctionData({
    abi: resolverAbi,
    functionName: "setText",
    args: [dnsEncode(NAME), "description", "Nightshift ENS spike"],
  });
  const data = encodeFunctionData({
    abi: resolverAbi,
    functionName: "initialize",
    args: [[{ account: account.address, roleBitmap: ALL_ROLES }], [initialText]],
  });
  const resolver = await deployProxy(
    `deploy resolver for ${NAME}`,
    PERMISSIONED_RESOLVER_IMPL,
    salt,
    data,
  );
  upsertEnv("ENS_HELLO_RESOLVER_ADDRESS", resolver);

  // roleBitmap 0: the owner holds the token but can't change resolver/subregistry or transfer (docs/03).
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  const hash = await wallet.writeContract({
    address: userRegistry,
    abi: registryAbi,
    functionName: "register",
    args: [
      LABEL,
      account.address,
      "0x0000000000000000000000000000000000000000",
      resolver,
      0n,
      expiry,
    ],
  });
  await send(`register ${NAME}`, hash);
  return resolver;
}

async function main() {
  console.log(`[ens] deployer ${account.address}`);
  const userRegistry = await ensureUserRegistry();
  await ensureSubregistry(userRegistry);
  const resolver = await ensureHello(userRegistry);

  const agentContext = JSON.stringify({ v: 1, spike: true, at: new Date().toISOString() });
  const hash = await wallet.writeContract({
    address: resolver,
    abi: resolverAbi,
    functionName: "setText",
    args: [dnsEncode(NAME), "agent-context", agentContext],
  });
  await send(`setText(${NAME}, agent-context)`, hash);

  const resolved = await pub.getEnsResolver({ name: normalize(NAME) });
  const text = await pub.getEnsText({ name: normalize(NAME), key: "agent-context" });
  const description = await pub.getEnsText({ name: normalize(NAME), key: "description" });
  console.log(
    `[ens] getEnsResolver(${NAME}) = ${resolved} ${sameAddress(resolved, resolver) ? "(matches)" : "(MISMATCH)"}`,
  );
  console.log(`[ens] getEnsText(${NAME}, description) = ${description}`);
  console.log(`[ens] getEnsText(${NAME}, agent-context) = ${text}`);
  if (text !== agentContext) throw new Error("[ens] agent-context read-back mismatch");
  console.log("[ens] OK: agent-context round trip through the Universal Resolver");
}

main().catch((err) => {
  console.error("[ens] spike failed:", err);
  process.exit(1);
});
