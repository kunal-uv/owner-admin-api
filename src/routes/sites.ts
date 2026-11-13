import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { actorOf, audit } from "../lib/audit.js";
import { requirePermission } from "../lib/auth.js";
import { callClient } from "../lib/clientApi.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";

/**
 * A client's website content, managed in the client's own product backend.
 *
 * With a platform key the console gets the full editor state (schema, draft,
 * published) from `/platform/site` and can save, publish and discard. Without
 * one it can still show what the website publishes, from the public
 * `/site-content`.
 */
export const sitesRouter = Router({ mergeParams: true });

async function load(clientId: string) {
	const client = await prisma.client.findUnique({ where: { id: clientId }, include: { storefronts: true } });
	if (!client) throw notFound("Client");
	return client;
}

const websiteUrl = (c: Awaited<ReturnType<typeof load>>) => {
	const primary = c.storefronts.find((s) => s.primary && s.verified) ?? c.storefronts.find((s) => s.verified);
	return primary ? `https://${primary.host}` : null;
};

const clientId = (params: Record<string, unknown>) => String(params.id);

sitesRouter.get("/", async (req, res) => {
	const client = await load(clientId(req.params));
	if (!client.apiBaseUrl) throw badRequest(`Set ${client.name}'s API address first (Client → Profile & settings → Product connection).`, "no_api_url");
	if (client.platformKeyEnc) {
		const site = await callClient<Record<string, unknown>>(client, "GET", "/platform/site", { platform: true });
		res.json({ mode: "managed", websiteUrl: websiteUrl(client), site });
		return;
	}
	const published = await callClient<Record<string, unknown>>(client, "GET", "/site-content");
	res.json({ mode: "public", websiteUrl: websiteUrl(client), published });
});

sitesRouter.post("/preview-token", async (req, res) => {
	const client = await load(clientId(req.params));
	const data = await callClient<{ token: string; expires_in?: number }>(client, "POST", "/platform/site/preview-token", { platform: true, json: {} });
	res.json(data);
});

const draftSchema = z.object({ content: z.object({}).passthrough() });

sitesRouter.put("/draft", requirePermission("website.write"), async (req, res) => {
	const { content } = draftSchema.parse(req.body);
	const client = await load(clientId(req.params));
	const state = await callClient(client, "PUT", "/platform/site/draft", { platform: true, json: { content } });
	await prisma.$transaction((tx) => audit(tx, actorOf(req), { action: "website.draft_saved", entityType: "website", entityId: client.id, entityName: client.name, summary: "Saved a website draft" }));
	res.json(state);
});

for (const [path, action, summary] of [
	["/publish", "website.published", "Published website changes"],
	["/discard", "website.discarded", "Discarded unpublished website changes"],
] as const) {
	sitesRouter.post(path, requirePermission("website.write"), async (req, res) => {
		const client = await load(clientId(req.params));
		const state = await callClient(client, "POST", `/platform/site${path}`, { platform: true, json: {} });
		await prisma.$transaction((tx) => audit(tx, actorOf(req), { action, entityType: "website", entityId: client.id, entityName: client.name, summary }));
		res.json(state);
	});
}

/** Image upload: the multipart body is streamed straight through to the client's backend. */
sitesRouter.post("/upload", requirePermission("website.write"), async (req, res) => {
	if (!req.is("multipart/form-data")) throw new HttpError(415, "unsupported_media_type", "Upload the image as multipart/form-data.");
	const length = Number(req.get("content-length") ?? 0);
	if (length > 9 * 1024 * 1024) throw new HttpError(413, "too_large", "Images must be 8 MB or smaller.");
	const client = await load(clientId(req.params));
	const data = await callClient<{ path: string }>(client, "POST", "/platform/site/upload", { platform: true, stream: req, timeoutMs: 60_000 });
	res.json(data);
});
