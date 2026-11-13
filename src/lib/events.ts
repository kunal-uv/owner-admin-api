import { createHmac } from "node:crypto";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { getSettings } from "./documents.js";

const MAX_ATTEMPTS = 8;

/**
 * Queues a signed event for the webhook URL in platform settings. Called after
 * the change is committed; delivery happens in `deliverWebhooks`.
 */
export async function emit(event: string, data: Record<string, unknown>) {
	try {
		const settings = await getSettings();
		if (!settings.webhookUrl || !config.webhookSecret) return;
		await prisma.webhookDelivery.create({
			data: {
				event,
				url: settings.webhookUrl,
				payload: { id: `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, type: event, createdAt: new Date().toISOString(), data } as never,
				status: "pending",
			},
		});
	} catch (err) {
		console.error(`[webhook] could not queue ${event}`, err);
	}
}

export const sign = (body: string, timestamp: number) =>
	createHmac("sha256", config.webhookSecret).update(`${timestamp}.${body}`).digest("hex");

let delivering = false;

export async function deliverWebhooks() {
	if (delivering) return;
	delivering = true;
	try {
		const due = await prisma.webhookDelivery.findMany({
			where: { status: "pending", nextAttemptAt: { lte: new Date() } },
			orderBy: { createdAt: "asc" },
			take: 25,
		});
		for (const d of due) {
			const body = JSON.stringify(d.payload);
			const ts = Math.floor(Date.now() / 1000);
			let error: string | null = null;
			try {
				const res = await fetch(d.url, {
					method: "POST",
					headers: { "content-type": "application/json", "x-platform-event": d.event, "x-platform-signature": `t=${ts},v1=${sign(body, ts)}` },
					body,
					signal: AbortSignal.timeout(10_000),
				});
				if (!res.ok) error = `HTTP ${res.status}`;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
			const attempts = d.attempts + 1;
			await prisma.webhookDelivery.update({
				where: { id: d.id },
				data: error
					? {
							attempts,
							lastError: error,
							status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
							// 1m, 2m, 4m … capped at 6h
							nextAttemptAt: new Date(Date.now() + Math.min(2 ** (attempts - 1) * 60_000, 6 * 3_600_000)),
						}
					: { attempts, status: "delivered", deliveredAt: new Date(), lastError: null },
			});
		}
	} finally {
		delivering = false;
	}
}
