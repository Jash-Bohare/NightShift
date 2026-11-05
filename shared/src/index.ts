// Constants shared by server, buyer and web. Values come from docs/03 and docs/07.

export const ENS_PARENT_NAME = "nightshift.eth";

// Text keys the agent owner may write on its resolver (docs/03 OWNER_KEYS).
export const OWNER_KEYS = [
  "agent-context",
  "agent-endpoint[x402]",
  "agent-endpoint[web]",
  "description",
  "avatar",
  "nightshift.skill",
  "nightshift.price",
  "nightshift.payto",
  "nightshift.model",
] as const;
export type OwnerKey = (typeof OWNER_KEYS)[number];

// Only the NightshiftRegistrar may write this key.
export const REPUTATION_KEY = "nightshift.reputation";

export const SKILL_IDS = ["transcribe:ta", "transcribe:hi", "transcribe:en"] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export const HEDERA_NETWORK = "hedera:testnet";
export const HEDERA_USDC_TOKEN_ID = "0.0.429274";
export const USDC_DECIMALS = 6;
