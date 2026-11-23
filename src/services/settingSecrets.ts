/**
 * The ONE place a secret that Kyle types or generates in Settings is encrypted and decrypted (work
 * order C6b): the agent webhooks' custom header values and their HMAC signing secrets.
 *
 * AES-256-GCM with a random 12-byte IV per value and the auth tag kept with it. The key is derived by
 * HKDF-SHA256 from AGENT_KEY_PEPPER with its own info label, so the pepper itself is never the cipher
 * key and the agent-key hashing (a plain HMAC under the same pepper) shares nothing with this. With
 * AGENT_KEY_PEPPER unset nothing can be encrypted or decrypted: every function here refuses (fail
 * closed) and the callers say "Set AGENT_KEY_PEPPER in Railway first.".
 *
 * Stored form: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The plaintext never leaves this module
 * except through `decryptSecret`, which only the delivery code calls.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const SETTING_SECRETS_INFO = "rce-webhook-secrets-v1";
export const PEPPER_UNSET_MESSAGE = "Set AGENT_KEY_PEPPER in Railway first.";
const SALT = Buffer.from("rce-setting-secrets-salt-v1");

export class SettingSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingSecretsError";
  }
}

export function settingSecretsAvailable(): boolean {
  return Boolean(process.env.AGENT_KEY_PEPPER);
}

function key(): Buffer {
  const pepper = process.env.AGENT_KEY_PEPPER;
  if (!pepper) throw new SettingSecretsError(PEPPER_UNSET_MESSAGE);
  return Buffer.from(hkdfSync("sha256", pepper, SALT, SETTING_SECRETS_INFO, 32));
}

export function encryptSecret(plain: string): string {
  const k = key();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Throws SettingSecretsError (a fixed sentence, never the value) when the pepper is unset or the stored text does not decrypt. */
export function decryptSecret(stored: string): string {
  const k = key();
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new SettingSecretsError("A stored secret could not be read.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SettingSecretsError("A stored secret could not be read (was AGENT_KEY_PEPPER changed?).");
  }
}

/** What the screen shows after a save: bullets and the last four characters. A value under 8 characters shows bullets only (four of three would be the whole value). */
export function maskSecret(plain: string): string {
  return plain.length >= 8 ? `••••${plain.slice(-4)}` : "••••";
}

/** A new random signing secret: 32 random bytes, base64url (43 characters). */
export function generateSigningSecret(): string {
  return randomBytes(32).toString("base64url");
}
