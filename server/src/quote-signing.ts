import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { z } from "zod";

const QuoteClaimsSchema = z.object({
  v: z.literal(1),
  type: z.literal("nightshift-quote"),
  agentId: z.string().uuid(),
  label: z.string().regex(/^[a-z0-9-]{3,32}$/),
  ensName: z.string().min(1).max(255),
  units: z.number().int().positive().max(10_000),
  amount: z.string().regex(/^[1-9]\d*$/),
  asset: z.string().regex(/^0\.0\.\d+$/),
  network: z.string().min(1).max(64),
  payTo: z.string().regex(/^0\.0\.\d+$/),
  unit: z.string().min(1).max(32),
  status: z.enum(["active", "paused_budget"]),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  nonce: z.string().uuid(),
});

export type QuoteClaims = z.infer<typeof QuoteClaimsSchema>;

const StatusClaimsSchema = z.object({
  v: z.literal(1),
  type: z.literal("nightshift-job-status"),
  jobId: z.string().uuid(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

export type JobStatusClaims = z.infer<typeof StatusClaimsSchema>;

export const SIGNED_QUOTE_TTL_SECONDS = 120;
export const JOB_STATUS_TTL_SECONDS = 30 * 60;

function decodeKey(value: string, type: "private" | "public"): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error(`quote ${type} key must be base64-encoded DER`);
  const der = Buffer.from(value, "base64");
  if (der.length === 0 || der.toString("base64") !== value)
    throw new Error(`quote ${type} key must be canonical base64-encoded DER`);
  return der;
}

export function validateQuoteKeyPair(privateKey: string, publicKey: string): void {
  const privateObject = createPrivateKey({
    key: decodeKey(privateKey, "private"),
    format: "der",
    type: "pkcs8",
  });
  const publicObject = createPublicKey(privateObject);
  if (privateObject.asymmetricKeyType !== "ed25519" || publicObject.asymmetricKeyType !== "ed25519")
    throw new Error("quote keys must use Ed25519");
  const derived = publicObject.export({ format: "der", type: "spki" });
  const configured = decodeKey(publicKey, "public");
  const configuredObject = createPublicKey({
    key: configured,
    format: "der",
    type: "spki",
  });
  if (configuredObject.asymmetricKeyType !== "ed25519")
    throw new Error("quote keys must use Ed25519");
  if (derived.length !== configured.length || !timingSafeEqual(derived, configured))
    throw new Error("quote public key does not match the signing private key");
}

function encode(payload: unknown, privateKey: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = createPrivateKey({
    key: decodeKey(privateKey, "private"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, Buffer.from(body), key).toString("base64url");
  return `${body}.${signature}`;
}

export function decodeAndVerifyToken<T>(
  token: string,
  publicKey: string,
  schema: z.ZodType<T>,
  nowSeconds = Math.floor(Date.now() / 1000),
): T {
  if (token.length > 8192) throw new Error("signed token is too large");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("signed token is malformed");
  const payloadBytes = Buffer.from(parts[0], "base64url");
  const signatureBytes = Buffer.from(parts[1], "base64url");
  if (
    payloadBytes.length === 0 ||
    signatureBytes.length !== 64 ||
    payloadBytes.toString("base64url") !== parts[0] ||
    signatureBytes.toString("base64url") !== parts[1]
  )
    throw new Error("signed token encoding is invalid");
  const key = createPublicKey({
    key: decodeKey(publicKey, "public"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, Buffer.from(parts[0]), key, signatureBytes))
    throw new Error("signed token signature is invalid");
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error("signed token payload is malformed");
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error("signed token claims are invalid");
  const claims = parsed.data as { iat: number; exp: number };
  if (claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds || claims.exp <= claims.iat)
    throw new Error("signed token has expired or invalid timestamps");
  return parsed.data;
}

export function createSignedQuote(
  input: Omit<QuoteClaims, "v" | "type" | "iat" | "exp" | "nonce">,
  privateKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { claims: QuoteClaims; token: string } {
  const claims = QuoteClaimsSchema.parse({
    ...input,
    v: 1,
    type: "nightshift-quote",
    iat: nowSeconds,
    exp: nowSeconds + SIGNED_QUOTE_TTL_SECONDS,
    nonce: randomUUID(),
  });
  return { claims, token: encode(claims, privateKey) };
}

export function verifySignedQuote(
  token: string,
  publicKey: string,
  nowSeconds?: number,
): QuoteClaims {
  const claims = decodeAndVerifyToken(token, publicKey, QuoteClaimsSchema, nowSeconds);
  if (claims.exp - claims.iat > SIGNED_QUOTE_TTL_SECONDS)
    throw new Error("signed quote lifetime exceeds the allowed TTL");
  return claims;
}

export function createJobStatusToken(
  jobId: string,
  privateKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const claims = StatusClaimsSchema.parse({
    v: 1,
    type: "nightshift-job-status",
    jobId,
    iat: nowSeconds,
    exp: nowSeconds + JOB_STATUS_TTL_SECONDS,
  });
  return encode(claims, privateKey);
}

export function verifyJobStatusToken(
  token: string,
  publicKey: string,
  expectedJobId: string,
  nowSeconds?: number,
): JobStatusClaims {
  const claims = decodeAndVerifyToken(token, publicKey, StatusClaimsSchema, nowSeconds);
  if (claims.exp - claims.iat > JOB_STATUS_TTL_SECONDS)
    throw new Error("job status token lifetime exceeds the allowed TTL");
  if (claims.jobId !== expectedJobId)
    throw new Error("job status token does not match the requested job");
  return claims;
}

export function quoteTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
