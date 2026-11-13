import { prisma, type Tx } from "../db.js";
import type { PlatformSettings, WebsiteConfig } from "./types.js";

type Client = typeof prisma | Tx;

export async function getSettings(db: Client = prisma): Promise<PlatformSettings> {
	const row = await db.document.findUnique({ where: { key: "settings" } });
	if (!row) throw new Error("Platform settings are missing. Run `npm run setup -- --email you@company.com --name 'Your Name'`.");
	return row.data as unknown as PlatformSettings;
}

export async function getWebsite(db: Client = prisma): Promise<WebsiteConfig> {
	const row = await db.document.findUnique({ where: { key: "website" } });
	if (!row) throw new Error("Website config is missing. Run `npm run setup -- --email you@company.com --name 'Your Name'`.");
	return row.data as unknown as WebsiteConfig;
}

export async function putDocument(db: Client, key: "settings" | "website", data: object) {
	await db.document.upsert({ where: { key }, create: { key, data: data as never }, update: { data: data as never } });
}

/** Atomically increments a named counter and returns the new value. */
export async function nextCounter(db: Client, name: string, start: number): Promise<number> {
	const rows = await db.$queryRaw<{ value: number }[]>`
		INSERT INTO counters (name, value) VALUES (${name}, ${start})
		ON CONFLICT (name) DO UPDATE SET value = counters.value + 1
		RETURNING value`;
	return Number(rows[0].value);
}
