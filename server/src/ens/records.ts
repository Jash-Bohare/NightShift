// Initial ENS records for a new agent (docs/04 § ENS operations). Pure; unit-tested.
import { formatUsdc, HEDERA_NETWORK, type OwnerKey } from "@nightshift/shared";

export { formatUsdc };

const LANGUAGES: Record<string, string> = { ta: "Tamil", hi: "Hindi", en: "English" };

/** "tamil-scribe" -> "Tamil Scribe" */
export function titleFromLabel(label: string): string {
  return label
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export interface RecordInput {
  label: string;
  ensName: string;
  skill: string;
  model: string;
  priceAtomic: bigint;
  priceUnit: string;
  payTo: string;
  usdcTokenId: string;
  serverUrl: string;
  webUrl: string;
  /** Owner-written description; defaults to a generated one. */
  description?: string;
}

export function buildInitialRecords(a: RecordInput): { key: OwnerKey; value: string }[] {
  const [kind, lang = ""] = a.skill.split(":");
  const language = LANGUAGES[lang] ?? lang;
  const price = formatUsdc(a.priceAtomic);
  const what =
    kind === "transcribe" ? `Transcribes ${language} audio to text` : `Runs the ${a.skill} skill`;
  const description =
    a.description?.trim() ||
    `${what}. Runs ${a.model} on 0G Compute. Paid per ${a.priceUnit} in USDC via x402 on Hedera.`;
  const context = [
    `# ${titleFromLabel(a.label)}`,
    `${what}. Runs \`${a.model}\` on the 0G Compute Router (TEE provider).`,
    `- Price: ${price} USDC per ${a.priceUnit} (Hedera testnet, x402 exact scheme, asset ${a.usdcTokenId})`,
    `- Call: POST agent-endpoint[x402] with multipart \`file\` and header \`X-Nightshift-Units: <${a.priceUnit}s>\``,
    `- Quote: GET ${a.serverUrl}/a/${a.label}/quote?units=<n>`,
    `- Reputation: text record \`nightshift.reputation\` (written only by the Nightshift registrar)`,
  ].join("\n");
  return [
    { key: "agent-context", value: context },
    { key: "agent-endpoint[x402]", value: `${a.serverUrl}/a/${a.label}/run` },
    { key: "agent-endpoint[web]", value: `${a.webUrl}/agents/${a.label}` },
    { key: "description", value: description },
    { key: "nightshift.skill", value: a.skill },
    {
      key: "nightshift.price",
      value: JSON.stringify({
        amount: a.priceAtomic.toString(),
        asset: a.usdcTokenId,
        network: HEDERA_NETWORK,
        unit: a.priceUnit,
      }),
    },
    { key: "nightshift.payto", value: a.payTo },
    { key: "nightshift.model", value: a.model },
  ];
}

/**
 * Records for an owner edit (dashboard drawer, docs/06): only the keys the edit touches. A price
 * change rewrites `nightshift.price` and `agent-context` (whose text states the price) from the same
 * template as launch, so the two can never disagree.
 */
export function draftRecordEdits(
  current: RecordInput,
  edit: { priceAtomic?: bigint; description?: string },
): { key: OwnerKey; value: string }[] {
  const next = buildInitialRecords({
    ...current,
    ...(edit.priceAtomic !== undefined ? { priceAtomic: edit.priceAtomic } : {}),
    ...(edit.description !== undefined ? { description: edit.description } : {}),
  });
  const keys = new Set<OwnerKey>();
  if (edit.priceAtomic !== undefined) {
    keys.add("nightshift.price");
    keys.add("agent-context");
  }
  if (edit.description !== undefined) keys.add("description");
  return next.filter((r) => keys.has(r.key));
}

/**
 * Strictly parse a `nightshift.price` record. Returns the atomic amount only when asset, network
 * and unit match what this worker is paid in; otherwise a reason string.
 */
export function parsePriceRecord(
  text: string | undefined,
  expected: { asset: string; unit: string },
): { ok: true; amount: bigint } | { ok: false; reason: string } {
  let j: unknown;
  try {
    j = JSON.parse(text ?? "");
  } catch {
    return { ok: false, reason: "nightshift.price is not JSON" };
  }
  if (typeof j !== "object" || j === null)
    return { ok: false, reason: "nightshift.price is not an object" };
  const p = j as Record<string, unknown>;
  if (typeof p.amount !== "string" || !/^[1-9]\d{0,15}$/.test(p.amount))
    return { ok: false, reason: "nightshift.price amount is not a positive integer string" };
  if (p.asset !== expected.asset) return { ok: false, reason: `asset must be ${expected.asset}` };
  if (p.network !== HEDERA_NETWORK)
    return { ok: false, reason: `network must be ${HEDERA_NETWORK}` };
  if (p.unit !== expected.unit) return { ok: false, reason: `unit must be ${expected.unit}` };
  return { ok: true, amount: BigInt(p.amount) };
}
