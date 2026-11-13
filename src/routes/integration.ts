import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { Product as DbProduct } from "@prisma/client";
import { prisma } from "../db.js";
import { audit, type Actor } from "../lib/audit.js";
import { cachedSettings, takeAttempt } from "../lib/auth.js";
import { id, sha256 } from "../lib/crypto.js";
import { entitlementPayload } from "../lib/domain.js";
import { getWebsite, nextCounter } from "../lib/documents.js";
import { HttpError, notFound } from "../lib/errors.js";
import { emit } from "../lib/events.js";
import { publicLeadSchema, tenantMessageSchema, tenantTicketSchema, usageSchema } from "../lib/schemas.js";
import { clientOut, planOut, productOut, ticketOut } from "../lib/serialize.js";

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			product?: DbProduct;
		}
	}
}

/* ─── Product backends (service key) ──────────────────────────────────────── */

export const integrationRouter = Router();

/** `Authorization: Bearer sk_<product>_…` — issued from Products → Edit → Service API key. */
const requireServiceKey: RequestHandler = async (req, _res, next) => {
	const header = req.get("authorization") ?? "";
	const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	if (!key) throw new HttpError(401, "missing_service_key", "Send the product's service key as a Bearer token.");
	const product = await prisma.product.findUnique({ where: { serviceKeyHash: sha256(key) } });
	if (!product) throw new HttpError(401, "invalid_service_key", "Unknown or rotated service key.");
	req.product = product;
	next();
};

integrationRouter.use(requireServiceKey);

const productActor = (req: Parameters<RequestHandler>[0]): Actor => ({ id: `product:${req.product!.key}`, name: `${req.product!.name} (API)`, ip: req.ip });

async function tenant(req: Parameters<RequestHandler>[0], where: { slug: string } | { host: string }) {
	const client =
		"slug" in where
			? await prisma.client.findUnique({ where: { slug: where.slug }, include: { storefronts: true, plan: true } })
			: await prisma.client.findFirst({
					where: { OR: [{ adminHost: where.host }, { storefronts: { some: { host: where.host } } }] },
					include: { storefronts: true, plan: true },
				});
	// A product can only see its own tenants.
	if (!client || client.productId !== req.product!.id) throw notFound("Tenant");
	return client;
}

async function entitlements(req: Parameters<RequestHandler>[0], where: { slug: string } | { host: string }) {
	const client = await tenant(req, where);
	const settings = await cachedSettings();
	return entitlementPayload(clientOut(client), planOut(client.plan), productOut(req.product!), settings.maintenanceMode);
}

integrationRouter.get("/tenants/:slug/entitlements", async (req, res) => {
	res.set("cache-control", "private, max-age=60");
	res.json(await entitlements(req, { slug: String(req.params.slug) }));
});

integrationRouter.get("/hosts/:host/entitlements", async (req, res) => {
	res.set("cache-control", "private, max-age=60");
	res.json(await entitlements(req, { host: String(req.params.host).toLowerCase() }));
});

integrationRouter.post("/tenants/:slug/usage", async (req, res) => {
	const usage = usageSchema.parse(req.body);
	const client = await tenant(req, { slug: String(req.params.slug) });
	await prisma.$transaction([
		prisma.client.update({ where: { id: client.id }, data: { usage, usageReportedAt: new Date() } }),
		prisma.usageSnapshot.create({ data: { clientId: client.id, data: usage } }),
	]);
	res.json({ ok: true });
});

/** The product's admin calls this with the token from /impersonate?token=… (single use, 60 s). */
integrationRouter.post("/impersonate/exchange", async (req, res) => {
	const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
	const row = await prisma.impersonationToken.findUnique({ where: { tokenHash: sha256(token) } });
	if (!row || row.usedAt || row.expiresAt < new Date()) throw new HttpError(410, "token_expired", "This sign-in link has expired or was already used.");
	const client = await prisma.client.findUnique({ where: { id: row.clientId } });
	if (!client || client.productId !== req.product!.id) throw notFound("Tenant");
	const used = await prisma.impersonationToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
	if (!used.count) throw new HttpError(410, "token_expired", "This sign-in link was already used.");
	res.json({
		tenant: client.slug,
		staff: { id: row.staffId, name: row.staffName },
		reason: row.reason,
		// The product must cap the support session at this time and show an "impersonated by" banner.
		sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
	});
});

integrationRouter.get("/tenants/:slug/tickets", async (req, res) => {
	const client = await tenant(req, { slug: String(req.params.slug) });
	const tickets = await prisma.ticket.findMany({ where: { clientId: client.id }, include: { messages: true }, orderBy: { updatedAt: "desc" }, take: 100 });
	res.json({ tickets: tickets.map(ticketOut) });
});

integrationRouter.post("/tenants/:slug/tickets", async (req, res) => {
	const body = tenantTicketSchema.parse(req.body);
	const client = await tenant(req, { slug: String(req.params.slug) });
	const ticket = await prisma.$transaction(async (tx) => {
		const number = await nextCounter(tx, "ticket", 300);
		const t = await tx.ticket.create({
			data: {
				id: id("tk"),
				number,
				clientId: client.id,
				subject: body.subject,
				status: "open",
				priority: body.priority,
				messages: { create: { author: body.author, fromClient: true, body: body.body } },
			},
			include: { messages: true },
		});
		await audit(tx, productActor(req), { action: "ticket.created", entityType: "ticket", entityId: t.id, entityName: `#${t.number}`, summary: `${client.name}: ${body.subject}` });
		return t;
	});
	await emit("ticket.created", { ticketId: ticket.id, number: ticket.number, clientId: client.id });
	res.status(201).json({ ticket: ticketOut(ticket) });
});

integrationRouter.post("/tenants/:slug/tickets/:number/messages", async (req, res) => {
	const body = tenantMessageSchema.parse(req.body);
	const client = await tenant(req, { slug: String(req.params.slug) });
	const ticket = await prisma.ticket.findUnique({ where: { number: Number(String(req.params.number)) || -1 } });
	if (!ticket || ticket.clientId !== client.id) throw notFound("Ticket");
	const updated = await prisma.ticket.update({
		where: { id: ticket.id },
		// A client reply re-opens the ticket.
		data: { status: "open", updatedAt: new Date(), messages: { create: { author: body.author, fromClient: true, body: body.body } } },
		include: { messages: true },
	});
	res.status(201).json({ ticket: ticketOut(updated) });
});

/* ─── Public (marketing site) ─────────────────────────────────────────────── */

export const publicRouter = Router();

publicRouter.get("/pricing", async (req, res) => {
	const key = typeof req.query.product === "string" ? req.query.product : undefined;
	const products = await prisma.product.findMany({ where: { status: { in: ["live", "beta"] }, ...(key ? { key } : {}) }, include: { plans: true } });
	if (key && !products.length) throw notFound("Product");
	res.set("cache-control", "public, max-age=60");
	res.json({
		products: products.map((p) => ({
			key: p.key,
			name: p.name,
			tagline: p.tagline,
			features: productOut(p).features.map(({ key: k, name, group }) => ({ key: k, name, group })),
			plans: p.plans
				.filter((pl) => pl.isPublic && pl.status === "active")
				.sort((a, b) => a.sortOrder - b.sortOrder)
				.map((pl) => {
					const { id: _id, productId: _p, status: _s, isPublic: _i, createdAt: _c, ...rest } = planOut(pl);
					return rest;
				}),
		})),
	});
});

publicRouter.get("/website", async (_req, res) => {
	const [website, settings] = await Promise.all([getWebsite(), cachedSettings()]);
	res.set("cache-control", "public, max-age=60");
	res.json({ ...website, brandName: settings.brandName, maintenance: settings.maintenanceMode });
});

publicRouter.post("/leads", async (req, res) => {
	const body = publicLeadSchema.parse(req.body);
	if (!takeAttempt(`public-lead:${req.ip}`, 5, 60 * 60_000)) throw new HttpError(429, "too_many_requests", "Too many submissions. Try again later.");
	const website = await getWebsite();
	if (!website.leadFormEnabled) throw new HttpError(403, "form_closed", "The contact form is closed.");
	// Honeypot filled → pretend success, store nothing.
	if (body.website) {
		res.status(202).json({ ok: true });
		return;
	}
	const product = body.product ? await prisma.product.findUnique({ where: { key: body.product } }) : await prisma.product.findUnique({ where: { id: website.featuredProductId } });
	if (!product) throw notFound("Product");
	const plan = body.plan ? await prisma.plan.findUnique({ where: { code: body.plan } }) : null;
	// One open lead per email: a repeat submission adds to the existing one.
	const existing = await prisma.lead.findFirst({ where: { email: body.email, status: { in: ["new", "contacted", "demo_scheduled"] } } });
	await prisma.$transaction(async (tx) => {
		if (existing) {
			await tx.lead.update({ where: { id: existing.id }, data: { message: `${existing.message}\n\n[${new Date().toISOString().slice(0, 10)}] ${body.message}`.trim().slice(0, 4000) } });
			return;
		}
		const lead = await tx.lead.create({
			data: {
				id: id("ld"),
				name: body.name,
				company: body.company,
				email: body.email,
				phone: body.phone,
				productId: product.id,
				planId: plan && plan.productId === product.id ? plan.id : null,
				source: "website",
				status: "new",
				message: body.message,
			},
		});
		await audit(tx, { id: "website", name: "Website form" }, { action: "lead.created", entityType: "lead", entityId: lead.id, entityName: lead.company || lead.name, summary: "New enquiry from the website" });
	});
	res.status(202).json({ ok: true });
});
