// AES-256-GCM for per-agent secrets at rest (CLAUDE.md rule 4).
// Format: v1.<iv b64>.<tag b64>.<ciphertext b64>
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function keyFrom(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("SECRETS_MASTER_KEY must be 32 bytes of hex");
  return key;
}

export function encrypt(plain: string, masterKeyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(masterKeyHex), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decrypt(blob: string, masterKeyHex: string): string {
  const [version, iv, tag, ct] = blob.split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined)
    throw new Error("malformed secret blob");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFrom(masterKeyHex),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString(
    "utf8",
  );
}
