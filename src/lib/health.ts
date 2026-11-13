import { prisma } from "../db.js";
import { config } from "../config.js";
import type { Client } from "./types.js";

/** The product backend's /health when its API URL is known, else the admin host's. */
export function defaultHealthUrl(adminHost: string, apiBaseUrl?: string | null) {
	if (apiBaseUrl) {
		try {
			return `${new URL(apiBaseUrl).origin}/health`;
		} catch {
			/* fall through */
		}
	}
	return `https://${adminHost}/api/health`;
}

export async function probe(url: string): Promise<Client["health"]> {
	const started = performance.now();
	const checkedAt = new Date().toISOString();
	try {
		const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(config.healthTimeoutMs), redirect: "follow" });
		const latencyMs = Math.round(performance.now() - started);
		let version: string | undefined;
		try {
			const body = (await res.json()) as { version?: unknown };
			if (typeof body?.version === "string") version = body.version.slice(0, 40);
		} catch {
			/* health endpoint need not return JSON */
		}
		if (!res.ok) return { state: "down", latencyMs, checkedAt, version, error: `HTTP ${res.status}` };
		return { state: latencyMs > config.healthDegradedMs ? "degraded" : "up", latencyMs, checkedAt, version };
	} catch (err) {
		const error =
			err instanceof Error ? (err.name === "TimeoutError" ? `No answer within ${config.healthTimeoutMs} ms` : (err.cause as Error | undefined)?.message ?? err.message) : String(err);
		return { state: "down", checkedAt, error: error.slice(0, 200) };
	}
}

/** Probes each client's health URL (10 at a time) and stores the result. */
export async function checkClients(ids: string[]) {
	const clients = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, adminHost: true, healthUrl: true, apiBaseUrl: true, health: true } });
	for (let i = 0; i < clients.length; i += 10) {
		await Promise.all(
			clients.slice(i, i + 10).map(async (c) => {
				const previous = c.health as Client["health"];
				const health: Client["health"] = ["suspended", "cancelled"].includes(c.status)
					? { state: "unknown", checkedAt: new Date().toISOString(), version: previous?.version }
					: await probe(c.healthUrl || defaultHealthUrl(c.adminHost, c.apiBaseUrl));
				if (!health.version && previous?.version) health.version = previous.version;
				await prisma.client.update({ where: { id: c.id }, data: { health: health as never } });
			}),
		);
	}
	return clients.length;
}
