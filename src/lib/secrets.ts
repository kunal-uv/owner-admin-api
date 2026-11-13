import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "./errors.js";

/**
 * AES-256-GCM for secrets kept in the database (clients' platform keys).
 * Stored as "v1.<iv>.<tag>.<ciphertext>", all base64url.
 */
function key(): Buffer {
	const k = Buffer.from(config.secretsKey, "base64");
	if (k.length !== 32) throw new HttpError(500, "secrets_not_configured", "SECRETS_KEY isn't set on the API server, so secrets can't be stored.");
	return k;
}

export const secretsConfigured = () => Buffer.from(config.secretsKey, "base64").length === 32;

export function encrypt(plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key(), iv);
	const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
	return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(stored: string): string {
	const [v, iv, tag, data] = stored.split(".");
	if (v !== "v1" || !iv || !tag || !data) throw new HttpError(500, "secret_unreadable", "A stored secret is corrupt. Enter it again.");
	try {
		const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
		decipher.setAuthTag(Buffer.from(tag, "base64url"));
		return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(500, "secret_unreadable", "The stored platform key can't be decrypted (SECRETS_KEY changed?). Enter it again.");
	}
}
