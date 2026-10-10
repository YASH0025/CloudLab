import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * Real SSH key pairs, generated the way the cloud does it, so the downloaded
 * .pem file works with ssh-keygen and other tools. Nothing here is ever stored:
 * the private key is shown once, at creation.
 */

export type KeyType = "rsa" | "ed25519";

export interface GeneratedKey {
  /** The private key file's contents (.pem). */
  keyMaterial: string;
  /** OpenSSH public key line, e.g. "ssh-ed25519 AAAA... my-key". */
  publicKey: string;
  /** RSA: SHA-1 of the private key (DER), colon separated. ED25519: base64 SHA-256 of the public key. */
  fingerprint: string;
}

/** SSH wire format: a uint32 length followed by the bytes. */
function sshString(data: Buffer | string): Buffer {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** Big-endian unsigned integer as an SSH "mpint" (leading zero if the top bit is set). */
function mpint(data: Buffer): Buffer {
  let i = 0;
  while (i < data.length - 1 && data[i] === 0) i++;
  let body = data.subarray(i);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return sshString(body);
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,70}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

const b64url = (s: string) => Buffer.from(s, "base64url");

function rsaKey(name: string): GeneratedKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyMaterial = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  const fingerprint = createHash("sha1").update(pkcs8).digest("hex").match(/../g)!.join(":");
  const jwk = publicKey.export({ format: "jwk" });
  const blob = Buffer.concat([sshString("ssh-rsa"), mpint(b64url(jwk.e!)), mpint(b64url(jwk.n!))]);
  return { keyMaterial, publicKey: `ssh-rsa ${blob.toString("base64")} ${name}`, fingerprint };
}

function ed25519Key(name: string): GeneratedKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = b64url(publicKey.export({ format: "jwk" }).x!);
  const seed = b64url(privateKey.export({ format: "jwk" }).d!);
  const pubBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);

  // OpenSSH's own private key format, which is what the cloud returns for ED25519 keys.
  const check = randomBytes(4);
  let secret = Buffer.concat([
    check,
    check,
    sshString("ssh-ed25519"),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(name),
  ]);
  const pad = (8 - (secret.length % 8)) % 8;
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const der = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(pubBlob),
    sshString(secret),
  ]);
  return {
    keyMaterial: pem("OPENSSH PRIVATE KEY", der),
    publicKey: `ssh-ed25519 ${pubBlob.toString("base64")} ${name}`,
    fingerprint: createHash("sha256").update(pubBlob).digest("base64"),
  };
}

export function generateKey(type: KeyType, name: string): GeneratedKey {
  return type === "ed25519" ? ed25519Key(name) : rsaKey(name);
}
