import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const PREFIX = "enc:v1:";
const ALG = "aes-256-gcm";
const MASK = "••••••••";

function key() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required");
  let k: Buffer;
  if (/^[0-9a-f]{64}$/i.test(raw)) k = Buffer.from(raw, "hex");
  else {
    try { k = Buffer.from(raw, "base64"); } catch { k = Buffer.alloc(0); }
  }
  if (k.length !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes (64 hex or base64)");
  return k;
}

export function isEncryptedSecret(v: string | null | undefined) {
  return typeof v === "string" && v.startsWith(PREFIX);
}

export function encryptSecret(value: string | null | undefined) {
  const plain = String(value || "");
  if (!plain || isEncryptedSecret(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map(x => x.toString("base64url")).join(".");
}

export function decryptSecret(value: string | null | undefined) {
  const stored = String(value || "");
  if (!stored) return "";
  if (!isEncryptedSecret(stored)) return stored; // legacy row; caller migrates after successful use/write
  const parts = stored.slice(PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("Encrypted credential envelope is invalid");
  const [iv, tag, ciphertext] = parts.map(x => Buffer.from(x, "base64url"));
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error("Encrypted credential envelope is invalid");
  const decipher = createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function maskSecret(value: string | null | undefined) {
  return value ? MASK : "";
}

export function isMask(value: unknown) {
  return value === MASK;
}

export function credentialKeyId() {
  return createHash("sha256").update(key()).digest("hex").slice(0, 16);
}
