import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encryption for access key secrets. Like AWS, CloudLab must keep a key's secret
 * to check request signatures (for SDK access), but it never shows it again
 * after creation. Secrets are stored AES-256-GCM encrypted.
 *
 * The key comes from CLOUDLAB_SECRET_KEY, falling back to BETTER_AUTH_SECRET.
 * Without either (local development and tests) a fixed development key is used.
 */
function key(): Buffer {
  const material = process.env.CLOUDLAB_SECRET_KEY || process.env.BETTER_AUTH_SECRET || "cloudlab-development-only-key";
  return createHash("sha256").update(`cloudlab-access-keys:${material}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split(".");
  if (version !== "v1") throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/** A 40-character secret access key, like AWS's. */
export function newSecretAccessKey(): string {
  return randomBytes(30).toString("base64").replace(/[^A-Za-z0-9+/]/g, "").slice(0, 40);
}
