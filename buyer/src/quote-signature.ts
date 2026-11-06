import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";

const SignedQuoteClaims = z.object({
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

export type VerifiedQuoteClaims = z.infer<typeof SignedQuoteClaims>;
const JobStatusClaims = z.object({
  v: z.literal(1),
  type: z.literal("nightshift-job-status"),
  jobId: z.string().uuid(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

export function verifyQuoteToken(
  token: string,
  publicKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifiedQuoteClaims {
  if (token.length > 8192) throw new Error("signed quote is too large");
  const [encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra.length > 0)
    throw new Error("signed quote is malformed");
  const payload = Buffer.from(encodedPayload, "base64url");
  const signature = Buffer.from(encodedSignature, "base64url");
  if (
    payload.length === 0 ||
    signature.length !== 64 ||
    payload.toString("base64url") !== encodedPayload ||
    signature.toString("base64url") !== encodedSignature
  )
    throw new Error("signed quote encoding is invalid");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey))
    throw new Error("quote verification key must be base64-encoded DER");
  const der = Buffer.from(publicKey, "base64");
  if (!der.length || der.toString("base64") !== publicKey)
    throw new Error("quote verification key must be canonical base64-encoded DER");
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("quote verification key must be Ed25519");
  if (!verify(null, Buffer.from(encodedPayload), key, signature))
    throw new Error("signed quote signature is invalid");
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("signed quote payload is malformed");
  }
  const parsed = SignedQuoteClaims.safeParse(decoded);
  if (!parsed.success) throw new Error("signed quote claims are invalid");
  if (
    parsed.data.iat > nowSeconds + 30 ||
    parsed.data.exp <= nowSeconds ||
    parsed.data.exp <= parsed.data.iat ||
    parsed.data.exp - parsed.data.iat > 120
  )
    throw new Error("signed quote has expired or invalid timestamps");
  return parsed.data;
}

export function verifyJobStatusToken(
  token: string,
  publicKey: string,
  expectedJobId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (token.length > 8192) throw new Error("job status token is too large");
  const [encodedPayload, encodedSignature, ...extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra.length > 0)
    throw new Error("job status token is malformed");
  const payload = Buffer.from(encodedPayload, "base64url");
  const signature = Buffer.from(encodedSignature, "base64url");
  if (
    payload.length === 0 ||
    signature.length !== 64 ||
    payload.toString("base64url") !== encodedPayload ||
    signature.toString("base64url") !== encodedSignature
  )
    throw new Error("job status token encoding is invalid");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey))
    throw new Error("quote verification key must be base64-encoded DER");
  const der = Buffer.from(publicKey, "base64");
  if (!der.length || der.toString("base64") !== publicKey)
    throw new Error("quote verification key must be canonical base64-encoded DER");
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("quote verification key must be Ed25519");
  if (!verify(null, Buffer.from(encodedPayload), key, signature))
    throw new Error("job status token signature is invalid");
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("job status token payload is malformed");
  }
  const parsed = JobStatusClaims.safeParse(decoded);
  if (!parsed.success || parsed.data.jobId !== expectedJobId)
    throw new Error("job status token claims are invalid");
  if (
    parsed.data.iat > nowSeconds + 30 ||
    parsed.data.exp <= nowSeconds ||
    parsed.data.exp <= parsed.data.iat ||
    parsed.data.exp - parsed.data.iat > 30 * 60
  )
    throw new Error("job status token has expired or invalid timestamps");
}
