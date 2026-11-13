import type { Request } from "express";
import { config } from "../config.js";
import { badRequest, HttpError } from "./errors.js";
import { decrypt } from "./secrets.js";

/**
 * Calls a client's own product backend (e.g. its RentBuddyz API).
 *
 * Platform routes (`/platform/*`) authenticate with the client's platform key
 * (the backend's PLATFORM_API_KEY, stored here encrypted). Public routes such
 * as `/site-content` need nothing.
 */

export function normaliseApiUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw badRequest("Enter the API address, e.g. https://api.example.com/api", "invalid_api_url");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && !config.isProd)) {
		throw badRequest("The client's API must use https.", "invalid_api_url");
	}
	if (url.username || url.password || url.search || url.hash) throw badRequest("Leave credentials, query and # out of the API address.", "invalid_api_url");
	return url.toString().replace(/\/+$/, "");
}

type Target = { name: string; apiBaseUrl: string | null; platformKeyEnc: string | null };

type Envelope<T> = { code?: number; success?: boolean; message?: string; data?: T };

export interface CallOptions {
	/** Send the platform key (required for /platform/*). */
	platform?: boolean;
	json?: unknown;
	/** Stream the incoming request body through unchanged (file uploads). */
	stream?: Request;
	timeoutMs?: number;
}

export async function callClient<T>(client: Target, method: string, path: string, opts: CallOptions = {}): Promise<T> {
	if (!client.apiBaseUrl) throw badRequest(`Set ${client.name}'s API address first (Client → Profile & settings → Product connection).`, "no_api_url");
	const headers: Record<string, string> = { accept: "application/json" };
	if (opts.platform) {
		if (!client.platformKeyEnc) throw badRequest(`Add ${client.name}'s platform key first (Client → Profile & settings → Product connection).`, "no_platform_key");
		headers["x-platform-key"] = decrypt(client.platformKeyEnc);
	}
	let body: RequestInit["body"];
	if (opts.json !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(opts.json);
	} else if (opts.stream) {
		const type = opts.stream.get("content-type");
		if (type) headers["content-type"] = type;
		const length = opts.stream.get("content-length");
		if (length) headers["content-length"] = length;
		body = opts.stream as unknown as RequestInit["body"];
	}

	let res: Response;
	try {
		res = await fetch(`${client.apiBaseUrl}${path}`, {
			method,
			headers,
			body,
			signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
			redirect: "error",
			...(opts.stream ? { duplex: "half" } : {}),
		} as RequestInit);
	} catch (err) {
		const reason = err instanceof Error ? (err.name === "TimeoutError" ? "it didn't answer in time" : ((err.cause as Error | undefined)?.message ?? err.message)) : String(err);
		throw new HttpError(502, "client_unreachable", `Can't reach ${client.name}'s backend at ${client.apiBaseUrl} — ${reason}.`);
	}

	let payload: Envelope<T> | null = null;
	try {
		payload = (await res.json()) as Envelope<T>;
	} catch {
		/* not JSON */
	}

	if (res.ok) {
		if (payload && typeof payload === "object" && "data" in payload) return payload.data as T;
		throw new HttpError(502, "client_bad_response", `${client.name}'s backend answered, but not with the expected data. Is the API address right?`);
	}
	if (opts.platform && res.status === 404) {
		throw new HttpError(502, "platform_disabled", `${client.name}'s backend doesn't have platform access switched on. Set PLATFORM_API_KEY there (and deploy the platform routes).`);
	}
	if (opts.platform && res.status === 401) {
		throw new HttpError(502, "platform_key_rejected", `${client.name}'s backend rejected the platform key. Check it matches PLATFORM_API_KEY there.`);
	}
	const message = payload?.message || `HTTP ${res.status}`;
	// Validation problems from the client's backend are the user's to fix; anything else is a gateway error.
	if (res.status === 400 || res.status === 413) throw new HttpError(400, "client_rejected", message);
	throw new HttpError(502, "client_error", `${client.name}'s backend returned an error: ${message}`);
}
