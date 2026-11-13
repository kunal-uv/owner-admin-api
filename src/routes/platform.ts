import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { actorOf, audit } from "../lib/audit.js";
import { cachedSettings, invalidateSettingsCache, ipAllowed, parseAllowlist, requirePermission, requireTwoFactorOn } from "../lib/auth.js";
import { id } from "../lib/crypto.js";
import { getSettings, getWebsite, putDocument } from "../lib/documents.js";
import { secretsConfigured } from "../lib/secrets.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { emit } from "../lib/events.js";
import { runLifecycle } from "../lib/lifecycle.js";
import { sendMail } from "../lib/mail.js";
import { settingsSchema, staffInviteSchema, staffPatchSchema, websiteSchema } from "../lib/schemas.js";
import { auditOut, clientOut, invoiceOut, leadOut, planOut, productOut, staffOut, ticketOut } from "../lib/serialize.js";
import type { Database, PlatformSettings } from "../lib/types.js";
import { issueStaffLink, meOut } from "./auth.js";

export const platformRouter = Router();

/* ─── Everything the console needs, in one request ────────────────────────── */

platformRouter.get("/state", async (req, res) => {
	const [products, plans, clients, leads, invoices, tickets, staff, audit, website, settings] = await Promise.all([
		prisma.product.findMany({ orderBy: { createdAt: "asc" } }),
		prisma.plan.findMany({ orderBy: [{ productId: "asc" }, { sortOrder: "asc" }] }),
		prisma.client.findMany({ include: { storefronts: true }, orderBy: { createdAt: "desc" } }),
		prisma.lead.findMany({ orderBy: { createdAt: "desc" } }),
		prisma.invoice.findMany({ orderBy: [{ issuedAt: "desc" }, { number: "desc" }] }),
		prisma.ticket.findMany({ include: { messages: true }, orderBy: { updatedAt: "desc" } }),
		prisma.staff.findMany({ orderBy: { createdAt: "asc" } }),
		prisma.auditEntry.findMany({ orderBy: { at: "desc" }, take: 1000 }),
		getWebsite(),
		getSettings(),
	]);
	const state: Database = {
		me: await meOut(req.staff!),
		capabilities: { smtp: !!config.smtpUrl, secrets: secretsConfigured(), webhooks: !!config.webhookSecret, twoFactor: config.twoFactor },
		products: products.map(productOut),
		plans: plans.map(planOut),
		clients: clients.map(clientOut),
		leads: leads.map(leadOut),
		invoices: invoices.map(invoiceOut),
		tickets: tickets.map(ticketOut),
		staff: staff.map(staffOut),
		audit: audit.map(auditOut),
		website,
		settings,
	};
	res.json(state);
});

/* ─── Settings & website ──────────────────────────────────────────────────── */

const sectionsChanged = (a: PlatformSettings, b: PlatformSettings) => {
	const names: Record<string, string> = { dunning: "dunning", security: "security", webhookUrl: "webhooks", maintenanceMode: "maintenance mode" };
	const changed = new Set<string>();
	for (const key of Object.keys(b) as (keyof PlatformSettings)[]) {
		if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changed.add(names[key] ?? (["taxRatePct", "invoicePrefix", "paymentTermsDays", "defaultCurrency", "billingEmail"].includes(key) ? "billing" : "general"));
	}
	return [...changed];
};

platformRouter.put("/settings", requirePermission("settings.write"), async (req, res) => {
	const body = settingsSchema.parse(req.body);
	const { invalid } = parseAllowlist(body.security.ipAllowlist);
	if (invalid.length) throw badRequest(`Not an IP address or CIDR range: ${invalid.join(", ")}`, "invalid_allowlist");
	if (!ipAllowed(body.security.ipAllowlist, req.ip)) {
		throw badRequest(`This allow-list would lock you out — your address (${req.ip}) isn't on it.`, "allowlist_lockout");
	}
	const before = await getSettings();
	const changed = sectionsChanged(before, body);
	if (!changed.length) throw badRequest("Nothing changed.");
	await prisma.$transaction(async (tx) => {
		await putDocument(tx, "settings", body);
		await audit(tx, actorOf(req), {
			action: "settings.updated",
			entityType: "settings",
			summary: `Updated ${changed.join(", ")} settings${before.maintenanceMode !== body.maintenanceMode ? ` — maintenance mode ${body.maintenanceMode ? "ON" : "off"}` : ""}`,
		});
	});
	invalidateSettingsCache();
	if (before.maintenanceMode !== body.maintenanceMode) await emit("platform.maintenance", { enabled: body.maintenanceMode });
	res.json({ settings: body });
});

platformRouter.put("/website", requirePermission("website.write"), async (req, res) => {
	const body = websiteSchema.parse(req.body);
	if (!(await prisma.product.findUnique({ where: { id: body.featuredProductId } }))) throw badRequest("Unknown featured product.");
	await prisma.$transaction(async (tx) => {
		await putDocument(tx, "website", body);
		await audit(tx, actorOf(req), { action: "website.published", entityType: "website", summary: "Published website & pricing page changes" });
	});
	res.json({ website: body });
});

/* ─── Team ────────────────────────────────────────────────────────────────── */

platformRouter.post("/staff/invite", requirePermission("team.write"), async (req, res) => {
	const body = staffInviteSchema.parse(req.body);
	if (await prisma.staff.findUnique({ where: { email: body.email } })) throw conflict("Someone with that email is already on the team.", "email_taken");
	const staff = await prisma.$transaction(async (tx) => {
		const s = await tx.staff.create({ data: { id: id("st"), name: body.name, email: body.email, role: body.role, status: "invited" } });
		await audit(tx, actorOf(req), { action: "staff.invited", entityType: "staff", entityId: s.id, entityName: s.email, summary: `Invited as ${body.role}` });
		return s;
	});
	const link = await issueStaffLink(staff.id, "invite");
	const settings = await cachedSettings();
	await sendMail(staff.email, `You're invited to the ${settings.brandName} owner console`, `Hi ${staff.name},\n\n${req.staff!.name} invited you to the owner console.\nSet your password here (link valid for 72 hours):\n${link}`);
	res.status(201).json({ staff: staffOut(staff), link });
});

async function assertOwnerRemains(staffId: string, nextRole?: string, nextStatus?: string) {
	const target = await prisma.staff.findUnique({ where: { id: staffId } });
	if (!target) throw notFound("Team member");
	const losesOwner = target.role === "owner" && target.status === "active" && ((nextRole && nextRole !== "owner") || nextStatus === "disabled");
	if (losesOwner) {
		const owners = await prisma.staff.count({ where: { role: "owner", status: "active" } });
		if (owners <= 1) throw badRequest("There must always be at least one active owner.", "last_owner");
	}
	return target;
}

platformRouter.patch("/staff/:id", requirePermission("team.write"), async (req, res) => {
	const body = staffPatchSchema.parse(req.body);
	if (String(req.params.id) === req.staff!.id && (body.role || body.status)) throw forbidden("You can't change your own role or disable yourself.");
	const target = await assertOwnerRemains(String(req.params.id), body.role, body.status);
	if (body.status === "active" && target.status === "invited") throw badRequest("Invited members become active when they accept the invite.");
	const changes: string[] = [];
	if (body.name && body.name !== target.name) changes.push(`Renamed to ${body.name}`);
	if (body.role && body.role !== target.role) changes.push(`Role → ${body.role}`);
	if (body.status && body.status !== target.status) changes.push(body.status === "disabled" ? "Disabled access" : "Re-enabled access");
	if (!changes.length) throw badRequest("Nothing changed.");
	const staff = await prisma.$transaction(async (tx) => {
		const s = await tx.staff.update({ where: { id: target.id }, data: body });
		if (body.status === "disabled" || (body.role && body.role !== target.role)) {
			await tx.staffSession.updateMany({ where: { staffId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
		}
		await audit(tx, actorOf(req), { action: "staff.updated", entityType: "staff", entityId: s.id, entityName: s.email, summary: changes.join("; ") });
		return s;
	});
	res.json({ staff: staffOut(staff) });
});

platformRouter.post("/staff/:id/link", requirePermission("team.write"), async (req, res) => {
	const target = await prisma.staff.findUnique({ where: { id: String(req.params.id) } });
	if (!target) throw notFound("Team member");
	if (target.status === "disabled") throw badRequest("Re-enable the account first.");
	const purpose = target.status === "invited" ? "invite" : "reset";
	const link = await issueStaffLink(target.id, purpose);
	await prisma.$transaction((tx) =>
		audit(tx, actorOf(req), { action: purpose === "invite" ? "staff.invite_resent" : "staff.reset_link", entityType: "staff", entityId: target.id, entityName: target.email, summary: purpose === "invite" ? "Re-sent invitation" : "Issued a password-reset link" }),
	);
	await sendMail(target.email, purpose === "invite" ? "Your owner console invitation" : "Reset your owner console password", `Hi ${target.name},\n\nUse this link within 72 hours:\n${link}`);
	res.json({ link, purpose });
});

platformRouter.post("/staff/:id/reset-mfa", requireTwoFactorOn, requirePermission("team.write"), async (req, res) => {
	const target = await prisma.staff.findUnique({ where: { id: String(req.params.id) } });
	if (!target) throw notFound("Team member");
	if (!target.mfaEnabled) throw badRequest("Two-factor authentication isn't on for this account.");
	const staff = await prisma.$transaction(async (tx) => {
		const s = await tx.staff.update({ where: { id: target.id }, data: { mfaEnabled: false, mfaSecret: null, mfaPendingSecret: null } });
		await tx.staffSession.updateMany({ where: { staffId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
		await audit(tx, actorOf(req), { action: "staff.mfa_reset", entityType: "staff", entityId: s.id, entityName: s.email, summary: "Reset two-factor authentication and signed them out" });
		return s;
	});
	res.json({ staff: staffOut(staff) });
});

/* ─── Operations ──────────────────────────────────────────────────────────── */

platformRouter.post("/lifecycle/run", requirePermission("billing.write"), async (req, res) => {
	const report = await runLifecycle();
	await prisma.$transaction((tx) =>
		audit(tx, actorOf(req), {
			action: "billing.lifecycle_run",
			entityType: "settings",
			summary: `Ran billing checks: ${report.overdueInvoices} overdue, ${report.suspended} suspended, ${report.cancelled} cancelled, ${report.trialsEnded} trials ended, ${report.renewed} renewed`,
		}),
	);
	res.json({ report });
});

platformRouter.get("/activity", requirePermission("settings.write"), async (_req, res) => {
	const [webhooks, emails] = await Promise.all([
		prisma.webhookDelivery.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
		prisma.emailOutbox.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
	]);
	res.json({
		webhooks: webhooks.map((w) => ({ id: w.id, event: w.event, url: w.url, status: w.status, attempts: w.attempts, lastError: w.lastError, createdAt: w.createdAt.toISOString(), deliveredAt: w.deliveredAt?.toISOString() })),
		emails: emails.map((e) => ({ id: e.id, to: e.to, subject: e.subject, status: e.status, error: e.error, createdAt: e.createdAt.toISOString() })),
	});
});

