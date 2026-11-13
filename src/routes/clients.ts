import { promises as dns } from "node:dns";
import { Router } from "express";
import { z } from "zod";
import type { Client as DbClient, Domain, Plan as DbPlan, Product as DbProduct } from "@prisma/client";
import { prisma } from "../db.js";
import { actorOf, audit } from "../lib/audit.js";
import { requirePermission } from "../lib/auth.js";
import { issueInvoice, periodPrice, planLine } from "../lib/billing.js";
import { id, randomToken, sha256 } from "../lib/crypto.js";
import { addCycle, effectiveFeatures, monthlyEquivalentCents, RESERVED_SLUGS } from "../lib/domain.js";
import { getSettings } from "../lib/documents.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { emit } from "../lib/events.js";
import { checkClients } from "../lib/health.js";
import { normaliseApiUrl } from "../lib/clientApi.js";
import { encrypt } from "../lib/secrets.js";
import { clientCreateSchema, clientPatchSchema, planChangeSchema, statusChangeSchema } from "../lib/schemas.js";
import { clientOut, invoiceOut, productOut } from "../lib/serialize.js";
import type { BillingCycle, Limits, StorefrontDomain } from "../lib/types.js";

export const clientsRouter = Router();

type FullClient = DbClient & { storefronts: Domain[]; product: DbProduct; plan: DbPlan };

async function load(clientId: string): Promise<FullClient> {
	const c = await prisma.client.findUnique({ where: { id: clientId }, include: { storefronts: true, product: true, plan: true } });
	if (!c) throw notFound("Client");
	return c;
}

const out = async (clientId: string) => clientOut(await prisma.client.findUniqueOrThrow({ where: { id: clientId }, include: { storefronts: true } }));

/** A host may belong to exactly one client, as an admin address or a storefront. */
async function assertHostsFree(hosts: string[], exceptClientId?: string) {
	if (!hosts.length) return;
	const [domains, admins] = await Promise.all([
		prisma.domain.findMany({ where: { host: { in: hosts }, ...(exceptClientId ? { clientId: { not: exceptClientId } } : {}) } }),
		prisma.client.findMany({ where: { adminHost: { in: hosts }, ...(exceptClientId ? { id: { not: exceptClientId } } : {}) }, select: { adminHost: true } }),
	]);
	const taken = [...domains.map((d) => d.host), ...admins.map((a) => a.adminHost)];
	if (taken.length) throw conflict(`${taken[0]} is already used by another client.`, "host_taken");
}

const isPlatformHost = (host: string, rootDomain: string) => host === rootDomain || host.endsWith(`.${rootDomain}`);

/* ─── Create ──────────────────────────────────────────────────────────────── */

clientsRouter.post("/", requirePermission("clients.write"), async (req, res) => {
	const body = clientCreateSchema.parse(req.body);
	if (RESERVED_SLUGS.has(body.slug)) throw badRequest("That slug is reserved.", "slug_reserved");
	if (await prisma.client.findUnique({ where: { slug: body.slug } })) throw conflict("That slug is already taken by another client.", "slug_taken");

	const product = await prisma.product.findUnique({ where: { id: body.productId } });
	if (!product) throw notFound("Product");
	if (product.status === "coming_soon" || product.status === "retired") throw badRequest(`${product.name} isn't open for new clients.`);
	const plan = await prisma.plan.findUnique({ where: { id: body.planId } });
	if (!plan || plan.productId !== product.id) throw badRequest("Pick a plan that belongs to this product.");
	if (plan.status !== "active") throw badRequest("That plan is archived.");

	const settings = await getSettings();
	const adminHost = product.adminHostPattern.replace("{slug}", body.slug).toLowerCase();
	const storefrontHost = product.storefrontHostPattern.replace("{slug}", body.slug).toLowerCase();
	await assertHostsFree([adminHost, storefrontHost]);

	if (body.leadId) {
		const lead = await prisma.lead.findUnique({ where: { id: body.leadId } });
		if (!lead) throw notFound("Lead");
		if (lead.clientId) throw conflict("This lead was already converted.");
	}

	const apiBaseUrl = body.apiBaseUrl ? normaliseApiUrl(body.apiBaseUrl) : null;
	const platformKeyEnc = body.platformKey ? encrypt(body.platformKey) : null;
	const now = new Date();
	const trial = body.trialDays > 0;
	const periodEnd = trial ? new Date(now.getTime() + body.trialDays * 86_400_000) : addCycle(now, body.billingCycle);
	const clientId = id("cl");
	const actor = actorOf(req);

	const invoice = await prisma.$transaction(async (tx) => {
		const client = await tx.client.create({
			data: {
				id: clientId,
				name: body.name,
				slug: body.slug,
				productId: product.id,
				planId: plan.id,
				status: trial ? "trial" : "active",
				billingCycle: body.billingCycle,
				contact: body.contact,
				company: { taxId: "", address: "", ...body.company, legalName: body.company.legalName || body.name },
				adminHost,
				usage: { stores: 0, staffUsers: 1, products: 0, ordersPerMonth: 0, storageGb: 0 },
				trialEndsAt: trial ? periodEnd : null,
				currentPeriodStart: now,
				currentPeriodEnd: periodEnd,
				health: { state: "unknown" },
				apiBaseUrl,
				platformKeyEnc,
				platformKeyHint: body.platformKey ? body.platformKey.slice(-4) : null,
				tags: [],
				notes: body.notes,
				leadId: body.leadId,
				storefronts: {
					create: [{ host: storefrontHost, verified: isPlatformHost(storefrontHost, settings.rootDomain), primary: true, sslStatus: isPlatformHost(storefrontHost, settings.rootDomain) ? "active" : "pending" }],
				},
			},
		});
		if (body.leadId) await tx.lead.update({ where: { id: body.leadId }, data: { status: "won", clientId } });
		await audit(tx, actor, {
			action: "client.created",
			entityType: "client",
			entityId: clientId,
			entityName: client.name,
			summary: trial ? `Created client on ${plan.name} with a ${body.trialDays}-day trial` : `Created client on ${plan.name} (${body.billingCycle})`,
		});
		if (trial) return null;
		return issueInvoice(tx, client, plan.currency, settings, {
			description: planLine(product.name, plan, body.billingCycle),
			amountCents: periodPrice(plan, body.billingCycle),
			periodStart: now,
			periodEnd,
		});
	});

	await emit("client.created", { clientId, slug: body.slug, product: product.key, plan: plan.code, status: trial ? "trial" : "active" });
	res.status(201).json({ client: await out(clientId), invoice: invoice ? invoiceOut(invoice) : null });
});

/* ─── Update ──────────────────────────────────────────────────────────────── */

clientsRouter.patch("/:id", requirePermission("clients.write"), async (req, res) => {
	const patch = clientPatchSchema.parse(req.body);
	if (!Object.keys(patch).length) throw badRequest("Nothing to update.");
	const client = await load(String(req.params.id));
	const settings = await getSettings();
	const product = productOut(client.product);
	const featureDefs = new Map(product.features.map((f) => [f.key, f]));
	const summaries: string[] = [];
	let action = "client.updated";
	let entitlementsChanged = false;

	if (patch.featureOverrides) {
		for (const key of Object.keys(patch.featureOverrides)) {
			const def = featureDefs.get(key);
			if (!def) throw badRequest(`Unknown feature "${key}" for ${product.name}.`);
			if (def.core) throw badRequest(`${def.name} is a core feature and is always on.`);
		}
		const before = effectiveFeatures(product, client.plan, client.featureOverrides as Record<string, boolean>);
		const after = effectiveFeatures(product, client.plan, patch.featureOverrides);
		const on = [...after].filter((k) => !before.has(k)).map((k) => featureDefs.get(k)?.name ?? k);
		const off = [...before].filter((k) => !after.has(k)).map((k) => featureDefs.get(k)?.name ?? k);
		if (on.length) summaries.push(`Turned on ${on.join(", ")}`);
		if (off.length) summaries.push(`Turned off ${off.join(", ")}`);
		if (!on.length && !off.length) summaries.push(Object.keys(patch.featureOverrides).length ? "Updated feature overrides" : "Cleared all feature overrides");
		action = "client.feature_override";
		entitlementsChanged = true;
	}

	if (patch.limitOverrides) {
		summaries.push(Object.keys(patch.limitOverrides).length ? `Limit overrides: ${Object.entries(patch.limitOverrides).map(([k, v]) => `${k}=${v}`).join(", ")}` : "Cleared limit overrides");
		action = "client.limits";
		entitlementsChanged = true;
	}

	if (patch.adminHost && patch.adminHost !== client.adminHost) {
		await assertHostsFree([patch.adminHost], client.id);
		if (client.storefronts.some((d) => d.host === patch.adminHost)) throw conflict("That host is one of this client's storefronts.");
		summaries.push(`Admin address → ${patch.adminHost}`);
		action = "client.domains";
		entitlementsChanged = true;
	}

	let nextDomains: { host: string; verified: boolean; primary: boolean; sslStatus: string; sortOrder: number }[] | null = null;
	if (patch.storefronts) {
		const hosts = patch.storefronts.map((s) => s.host);
		if (new Set(hosts).size !== hosts.length) throw badRequest("The same address is listed twice.");
		if (hosts.includes(patch.adminHost ?? client.adminHost)) throw conflict("A storefront can't use the admin address.");
		await assertHostsFree(hosts, client.id);
		const overrides = patch.featureOverrides ?? (client.featureOverrides as Record<string, boolean>);
		const customAllowed = effectiveFeatures(product, client.plan, overrides).has("custom_domain");
		const existing = new Map(client.storefronts.map((d) => [d.host, d]));
		const primaries = patch.storefronts.filter((s) => s.primary).length;
		if (primaries > 1) throw badRequest("Only one storefront address can be primary.");
		nextDomains = patch.storefronts.map((s: StorefrontDomain, i) => {
			const prev = existing.get(s.host);
			const platform = isPlatformHost(s.host, settings.rootDomain);
			if (!prev && !platform && !customAllowed) throw badRequest("Custom domains aren't included in this client's plan.", "feature_not_in_plan");
			// Verification state is ours to decide — never taken from the request.
			const verified = prev ? prev.verified : platform;
			return {
				host: s.host,
				verified,
				primary: primaries === 0 ? i === 0 : s.primary,
				sslStatus: prev ? prev.sslStatus : platform ? "active" : "pending",
				sortOrder: i,
			};
		});
		const primary = nextDomains.find((d) => d.primary);
		if (primary && !primary.verified) throw badRequest("Verify an address before making it primary.");
		const added = hosts.filter((h) => !existing.has(h));
		const removed = [...existing.keys()].filter((h) => !hosts.includes(h));
		const newPrimary = primary && !existing.get(primary.host)?.primary ? primary.host : null;
		if (added.length) summaries.push(`Added storefront ${added.join(", ")}`);
		if (removed.length) summaries.push(`Removed ${removed.join(", ")}`);
		if (newPrimary && !added.includes(newPrimary)) summaries.push(`Made ${newPrimary} primary`);
		if (!added.length && !removed.length && !newPrimary) summaries.push("Updated storefront order");
		action = "client.domains";
		entitlementsChanged = true;
	}

	if (patch.discountPct !== undefined && patch.discountPct !== client.discountPct) {
		summaries.push(`Discount set to ${patch.discountPct}%`);
		action = "client.discount";
	}

	const profileFields = (["name", "contact", "company", "tags", "notes", "healthUrl"] as const).filter((k) => patch[k] !== undefined);
	if (profileFields.length) summaries.push(`Updated profile (${profileFields.join(", ")})`);

	const apiBaseUrl = patch.apiBaseUrl === undefined ? undefined : patch.apiBaseUrl ? normaliseApiUrl(patch.apiBaseUrl) : null;
	if (apiBaseUrl !== undefined && apiBaseUrl !== client.apiBaseUrl) summaries.push(apiBaseUrl ? `API address → ${apiBaseUrl}` : "Removed the API address");
	let platformKey: { platformKeyEnc: string | null; platformKeyHint: string | null } | undefined;
	if (patch.platformKey !== undefined) {
		// The key itself is never logged — only that it changed.
		platformKey = patch.platformKey ? { platformKeyEnc: encrypt(patch.platformKey), platformKeyHint: patch.platformKey.slice(-4) } : { platformKeyEnc: null, platformKeyHint: null };
		summaries.push(patch.platformKey ? (client.platformKeyEnc ? "Replaced the platform key" : "Added a platform key") : "Removed the platform key");
	}
	if ((apiBaseUrl !== undefined && apiBaseUrl !== client.apiBaseUrl) || platformKey) action = "client.connection";

	await prisma.$transaction(async (tx) => {
		await tx.client.update({
			where: { id: client.id },
			data: {
				name: patch.name,
				contact: patch.contact,
				company: patch.company,
				adminHost: patch.adminHost,
				featureOverrides: patch.featureOverrides,
				limitOverrides: patch.limitOverrides as Partial<Limits> | undefined,
				discountPct: patch.discountPct,
				tags: patch.tags,
				notes: patch.notes,
				healthUrl: patch.healthUrl === undefined ? undefined : patch.healthUrl || null,
				apiBaseUrl,
				...platformKey,
			},
		});
		if (nextDomains) {
			await tx.domain.deleteMany({ where: { clientId: client.id, host: { notIn: nextDomains.map((d) => d.host) } } });
			for (const d of nextDomains) {
				await tx.domain.upsert({
					where: { host: d.host },
					create: { clientId: client.id, ...d },
					update: { primary: d.primary, sortOrder: d.sortOrder },
				});
			}
		}
		await audit(tx, actorOf(req), { action, entityType: "client", entityId: client.id, entityName: patch.name ?? client.name, summary: summaries.join("; ") || "Updated client" });
	});

	if (entitlementsChanged) await emit("entitlements.changed", { clientId: client.id, slug: client.slug });
	res.json({ client: await out(client.id) });
});

/* ─── Domains: DNS verification ───────────────────────────────────────────── */

clientsRouter.post("/:id/domains/verify", requirePermission("clients.write"), async (req, res) => {
	const body = z.object({ host: z.string().trim().toLowerCase(), manual: z.boolean().optional() }).parse(req.body);
	const client = await load(String(req.params.id));
	const domain = client.storefronts.find((d) => d.host === body.host);
	if (!domain) throw notFound("Storefront address");
	const settings = await getSettings();
	const edge = `edge.${settings.rootDomain}`;

	if (!body.manual) {
		let found = "no records";
		let ok = false;
		try {
			const cname = await dns.resolveCname(body.host);
			found = `CNAME ${cname.join(", ")}`;
			ok = cname.some((c) => c.replace(/\.$/, "").toLowerCase() === edge);
		} catch {
			try {
				const [mine, edgeIps] = await Promise.all([dns.resolve4(body.host), dns.resolve4(edge).catch(() => [] as string[])]);
				found = `A ${mine.join(", ")}`;
				ok = edgeIps.length > 0 && mine.every((ip) => edgeIps.includes(ip));
			} catch {
				/* no records at all */
			}
		}
		if (!ok) throw new HttpError(409, "dns_not_ready", `DNS for ${body.host} doesn't point to ${edge} yet (found ${found}). Add a CNAME record and try again in a few minutes.`);
	}

	await prisma.$transaction(async (tx) => {
		await tx.domain.update({ where: { id: domain.id }, data: { verified: true, sslStatus: "active" } });
		await audit(tx, actorOf(req), {
			action: "client.domains",
			entityType: "client",
			entityId: client.id,
			entityName: client.name,
			summary: body.manual ? `Marked ${body.host} verified manually` : `Verified DNS for ${body.host}`,
		});
	});
	await emit("entitlements.changed", { clientId: client.id, slug: client.slug });
	res.json({ client: await out(client.id) });
});

/* ─── Lifecycle ───────────────────────────────────────────────────────────── */

clientsRouter.post("/:id/status", requirePermission("clients.lifecycle"), async (req, res) => {
	const body = statusChangeSchema.parse(req.body);
	const client = await load(String(req.params.id));
	const to = body.status;
	if (client.status === to) throw badRequest(`The client is already ${to.replace("_", " ")}.`);
	if ((to === "suspended" || to === "cancelled") && (body.reason ?? "").length < 3) throw badRequest("Give a reason (at least 3 characters).", "reason_required");
	if (to === "suspended" && client.status === "cancelled") throw badRequest("Cancelled clients can't be suspended. Reactivate first.");
	if (client.status === "provisioning") throw badRequest("Wait for provisioning to finish.");

	const settings = await getSettings();
	const now = new Date();
	const cycle = client.billingCycle as BillingCycle;
	let summary = `Status changed to ${to}`;

	const invoice = await prisma.$transaction(async (tx) => {
		let issued = null;
		if (to === "active") {
			// Starting a new paid period: trial conversion, or a lapsed/cancelled subscription coming back.
			const startsNewPeriod = client.status === "trial" || client.trialEndsAt !== null || client.status === "cancelled" || client.currentPeriodEnd <= now;
			const data: Parameters<typeof tx.client.update>[0]["data"] = { status: "active", suspendedReason: null, cancelAt: null, pastDueSince: null, trialEndsAt: null };
			if (startsNewPeriod) {
				const end = addCycle(now, cycle);
				data.currentPeriodStart = now;
				data.currentPeriodEnd = end;
				issued = await issueInvoice(tx, client, client.plan.currency, settings, {
					description: planLine(client.product.name, client.plan, cycle),
					amountCents: periodPrice(client.plan, cycle),
					periodStart: now,
					periodEnd: end,
				});
			}
			await tx.client.update({ where: { id: client.id }, data });
			summary = client.status === "trial" ? "Converted trial to paid" : `Reactivated (was ${client.status.replace("_", " ")})`;
		} else if (to === "suspended") {
			await tx.client.update({ where: { id: client.id }, data: { status: "suspended", suspendedReason: body.reason } });
			summary = "Suspended";
		} else {
			await tx.client.update({ where: { id: client.id }, data: { status: "cancelled", cancelAt: now, pendingPlanId: null, pendingBillingCycle: null } });
			summary = "Cancelled subscription";
		}
		await audit(tx, actorOf(req), { action: `client.${to}`, entityType: "client", entityId: client.id, entityName: client.name, summary, reason: body.reason });
		return issued;
	});

	await emit("client.status_changed", { clientId: client.id, slug: client.slug, status: to });
	res.json({ client: await out(client.id), invoice: invoice ? invoiceOut(invoice) : null });
});

clientsRouter.post("/:id/plan", requirePermission("clients.write"), async (req, res) => {
	const body = planChangeSchema.parse(req.body);
	const client = await load(String(req.params.id));
	if (client.status === "cancelled") throw badRequest("Reactivate the client before changing its plan.");
	const next = await prisma.plan.findUnique({ where: { id: body.planId } });
	if (!next || next.productId !== client.productId) throw badRequest("Pick a plan of the same product.");
	if (next.status !== "active" && next.id !== client.planId) throw badRequest("That plan is archived.");
	const cycle = client.billingCycle as BillingCycle;
	if (next.id === client.planId && body.billingCycle === cycle) {
		if (client.pendingPlanId || client.pendingBillingCycle) throw badRequest("That's the current plan. Use “Keep current plan” to cancel the scheduled change.");
		throw badRequest("The client is already on that plan.");
	}

	const settings = await getSettings();
	const now = new Date();
	const paying = client.status === "active" || client.status === "past_due";
	const fromEq = monthlyEquivalentCents(client.plan, cycle);
	const toEq = monthlyEquivalentCents(next, body.billingCycle);

	let effect: "applied" | "scheduled";
	let summary: string;
	let invoice = null;

	if (!paying) {
		effect = "applied";
	} else if (body.billingCycle !== cycle || toEq < fromEq) {
		effect = "scheduled";
	} else {
		effect = "applied";
	}

	invoice = await prisma.$transaction(async (tx) => {
		let issued = null;
		if (effect === "scheduled") {
			await tx.client.update({ where: { id: client.id }, data: { pendingPlanId: next.id, pendingBillingCycle: body.billingCycle } });
			summary = `Scheduled ${next.name} (${body.billingCycle}) from ${client.currentPeriodEnd.toDateString()} — was ${client.plan.name} (${cycle})`;
		} else {
			await tx.client.update({ where: { id: client.id }, data: { planId: next.id, billingCycle: body.billingCycle, pendingPlanId: null, pendingBillingCycle: null } });
			summary = `Plan ${client.plan.name} (${cycle}) → ${next.name} (${body.billingCycle})`;
			if (paying && toEq > fromEq) {
				const total = client.currentPeriodEnd.getTime() - client.currentPeriodStart.getTime();
				const left = Math.max(0, client.currentPeriodEnd.getTime() - now.getTime());
				const amount = Math.round(((periodPrice(next, cycle) - periodPrice(client.plan, cycle)) * left) / Math.max(total, 1));
				if (amount > 0) {
					issued = await issueInvoice(tx, client, next.currency, settings, {
						description: `Upgrade ${client.plan.name} → ${next.name}, prorated for the rest of the period`,
						amountCents: amount,
						periodStart: now,
						periodEnd: client.currentPeriodEnd,
					});
					if (issued) summary += ` — prorated invoice ${issued.number}`;
				}
			}
		}
		await audit(tx, actorOf(req), { action: "client.plan_changed", entityType: "client", entityId: client.id, entityName: client.name, summary });
		return issued;
	});

	if (effect === "applied") await emit("entitlements.changed", { clientId: client.id, slug: client.slug });
	res.json({ client: await out(client.id), effect, invoice: invoice ? invoiceOut(invoice) : null });
});

clientsRouter.delete("/:id/pending-change", requirePermission("clients.write"), async (req, res) => {
	const client = await load(String(req.params.id));
	if (!client.pendingPlanId && !client.pendingBillingCycle) throw badRequest("There's no scheduled change.");
	await prisma.$transaction(async (tx) => {
		await tx.client.update({ where: { id: client.id }, data: { pendingPlanId: null, pendingBillingCycle: null } });
		await audit(tx, actorOf(req), { action: "client.plan_changed", entityType: "client", entityId: client.id, entityName: client.name, summary: `Cancelled the scheduled plan change — staying on ${client.plan.name}` });
	});
	res.json({ client: await out(client.id) });
});

/* ─── Health, impersonation, invoices, delete ─────────────────────────────── */

clientsRouter.post("/health-check", async (req, res) => {
	const body = z.object({ ids: z.array(z.string()).max(1000).optional() }).parse(req.body ?? {});
	const ids = body.ids ?? (await prisma.client.findMany({ select: { id: true } })).map((c) => c.id);
	const checked = await checkClients(ids);
	await prisma.$transaction((tx) => audit(tx, actorOf(req), { action: "client.health_check", entityType: "client", summary: `Ran health check on ${checked} client${checked === 1 ? "" : "s"}` }));
	const clients = await prisma.client.findMany({ where: { id: { in: ids } }, include: { storefronts: true } });
	res.json({ clients: clients.map(clientOut) });
});

clientsRouter.post("/:id/impersonate", requirePermission("clients.impersonate"), async (req, res) => {
	const body = z.object({ reason: z.string().trim().max(500).default("") }).parse(req.body ?? {});
	const client = await load(String(req.params.id));
	const settings = await getSettings();
	if (client.status === "cancelled") throw badRequest("Cancelled tenants can't be signed in to.");
	if (settings.security.impersonationNeedsReason && body.reason.length < 3) throw badRequest("Give a reason (at least 3 characters).", "reason_required");
	const token = randomToken();
	const staff = req.staff!;
	await prisma.$transaction(async (tx) => {
		await tx.impersonationToken.create({
			data: { tokenHash: sha256(token), staffId: staff.id, staffName: staff.name, clientId: client.id, reason: body.reason, expiresAt: new Date(Date.now() + 60_000) },
		});
		await audit(tx, actorOf(req), { action: "client.impersonated", entityType: "client", entityId: client.id, entityName: client.name, summary: "Signed in as the client's owner", reason: body.reason || undefined });
	});
	res.json({ url: `https://${client.adminHost}/impersonate?token=${encodeURIComponent(token)}`, expiresInSeconds: 60 });
});

clientsRouter.post("/:id/invoices", requirePermission("billing.write"), async (req, res) => {
	const client = await load(String(req.params.id));
	if (client.status === "trial") throw badRequest("Trials are invoiced when they convert to paid.");
	if (client.status === "cancelled") throw badRequest("Cancelled clients can't be invoiced. Reactivate first.");
	if (periodPrice(client.plan, client.billingCycle as BillingCycle) === 0) throw badRequest(`${client.name} is on a free plan — there's nothing to invoice.`, "free_plan");
	const settings = await getSettings();
	const cycle = client.billingCycle as BillingCycle;
	const invoice = await prisma.$transaction(async (tx) => {
		const inv = await issueInvoice(tx, client, client.plan.currency, settings, {
			description: planLine(client.product.name, client.plan, cycle),
			amountCents: periodPrice(client.plan, cycle),
			periodStart: client.currentPeriodStart,
			periodEnd: client.currentPeriodEnd,
		});
		if (!inv) throw badRequest("Nothing to invoice.");
		await audit(tx, actorOf(req), { action: "invoice.issued", entityType: "invoice", entityId: inv.id, entityName: inv.number, summary: `Issued ${inv.number} to ${client.name}` });
		return inv;
	});
	await emit("invoice.issued", { invoiceId: invoice.id, number: invoice.number, clientId: client.id });
	res.status(201).json({ invoice: invoiceOut(invoice) });
});

clientsRouter.delete("/:id", requirePermission("clients.lifecycle"), async (req, res) => {
	const body = z.object({ confirmSlug: z.string() }).parse(req.body ?? {});
	const client = await load(String(req.params.id));
	if (body.confirmSlug !== client.slug) throw badRequest("Type the client's slug to confirm.", "confirmation_mismatch");
	await prisma.$transaction(async (tx) => {
		await tx.client.delete({ where: { id: client.id } });
		await tx.lead.updateMany({ where: { clientId: client.id }, data: { clientId: null } });
		await audit(tx, actorOf(req), { action: "client.deleted", entityType: "client", entityId: client.id, entityName: client.name, summary: "Deleted client — invoices, tickets and audit history are kept" });
	});
	await emit("client.deleted", { clientId: client.id, slug: client.slug });
	res.json({ ok: true });
});
