import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { actorOf, audit } from "../lib/audit.js";
import { requirePermission } from "../lib/auth.js";
import { id } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";
import { emit } from "../lib/events.js";
import { sendMail } from "../lib/mail.js";
import { leadSchema, ticketPatchSchema } from "../lib/schemas.js";
import { clientOut, invoiceOut, leadOut, ticketOut } from "../lib/serialize.js";
import type { ClientContact, LeadStatus } from "../lib/types.js";

const leadStatusLabel: Record<LeadStatus, string> = { new: "New", contacted: "Contacted", demo_scheduled: "Demo scheduled", won: "Won", lost: "Lost" };

/* ─── Leads ───────────────────────────────────────────────────────────────── */

export const leadsRouter = Router();

async function checkLeadRefs(body: z.infer<typeof leadSchema>) {
	if (!(await prisma.product.findUnique({ where: { id: body.productId } }))) throw badRequest("Unknown product.");
	if (body.planId) {
		const plan = await prisma.plan.findUnique({ where: { id: body.planId } });
		if (!plan || plan.productId !== body.productId) throw badRequest("That plan isn't part of the selected product.");
	}
	if (body.assigneeId && !(await prisma.staff.findUnique({ where: { id: body.assigneeId } }))) throw badRequest("Unknown team member.");
	if (body.status === "lost" && (body.lostReason ?? "").length < 3) throw badRequest("Say why the lead was lost.", "reason_required");
}

leadsRouter.post("/", requirePermission("leads.write"), async (req, res) => {
	const body = leadSchema.parse(req.body);
	if (body.status === "won") throw badRequest("Convert the lead to a client to mark it won.");
	await checkLeadRefs(body);
	const lead = await prisma.$transaction(async (tx) => {
		const l = await tx.lead.create({
			data: { id: id("ld"), ...body, planId: body.planId ?? null, assigneeId: body.assigneeId ?? null, lostReason: body.status === "lost" ? body.lostReason : null },
		});
		await audit(tx, actorOf(req), { action: "lead.created", entityType: "lead", entityId: l.id, entityName: l.company || l.name, summary: `Added lead (${l.source})` });
		return l;
	});
	res.status(201).json({ lead: leadOut(lead) });
});

leadsRouter.put("/:id", requirePermission("leads.write"), async (req, res) => {
	const body = leadSchema.parse(req.body);
	const current = await prisma.lead.findUnique({ where: { id: String(req.params.id) } });
	if (!current) throw notFound("Lead");
	if (current.status === "won" && body.status !== "won") throw badRequest("This lead is already a client.");
	if (body.status === "won" && current.status !== "won") throw badRequest("Convert the lead to a client to mark it won.");
	await checkLeadRefs(body);
	const changes: string[] = [];
	if (body.status !== current.status) changes.push(body.status === "lost" ? `Marked lost: ${body.lostReason}` : `Status → ${leadStatusLabel[body.status]}`);
	if ((body.assigneeId ?? null) !== current.assigneeId) {
		const who = body.assigneeId ? (await prisma.staff.findUnique({ where: { id: body.assigneeId } }))?.name : "nobody";
		changes.push(`Assigned to ${who}`);
	}
	if (body.productId !== current.productId || (body.planId ?? null) !== current.planId) changes.push("Changed product/plan of interest");
	const lead = await prisma.$transaction(async (tx) => {
		const l = await tx.lead.update({
			where: { id: current.id },
			data: { ...body, planId: body.planId ?? null, assigneeId: body.assigneeId ?? null, lostReason: body.status === "lost" ? body.lostReason : null },
		});
		await audit(tx, actorOf(req), { action: "lead.updated", entityType: "lead", entityId: l.id, entityName: l.company || l.name, summary: changes.join("; ") || "Updated lead details" });
		return l;
	});
	res.json({ lead: leadOut(lead) });
});

/* ─── Invoices ────────────────────────────────────────────────────────────── */

export const invoicesRouter = Router();

invoicesRouter.post("/:id/status", requirePermission("billing.write"), async (req, res) => {
	const { status } = z.object({ status: z.enum(["paid", "void"]) }).parse(req.body);
	const inv = await prisma.invoice.findUnique({ where: { id: String(req.params.id) } });
	if (!inv) throw notFound("Invoice");
	if (!["open", "overdue"].includes(inv.status)) throw badRequest(`${inv.number} is already ${inv.status}.`);

	let recovered = false;
	const updated = await prisma.$transaction(async (tx) => {
		const i = await tx.invoice.update({ where: { id: inv.id }, data: { status, paidAt: status === "paid" ? new Date() : null } });
		await audit(tx, actorOf(req), { action: `invoice.${status}`, entityType: "invoice", entityId: i.id, entityName: i.number, summary: `Marked ${i.number} ${status}` });
		// Settling the last overdue invoice ends dunning for the client.
		const client = await tx.client.findUnique({ where: { id: inv.clientId } });
		const stillOverdue = await tx.invoice.count({ where: { clientId: inv.clientId, status: "overdue" } });
		if (client && !stillOverdue) {
			const dunningSuspension = client.status === "suspended" && client.suspendedReason === "Unpaid invoices";
			if (client.status === "past_due" || dunningSuspension) {
				await tx.client.update({ where: { id: client.id }, data: { status: "active", pastDueSince: null, suspendedReason: null } });
				await audit(tx, actorOf(req), { action: "client.active", entityType: "client", entityId: client.id, entityName: client.name, summary: "Overdue balance settled — reactivated" });
				recovered = true;
			} else if (client.pastDueSince) {
				await tx.client.update({ where: { id: client.id }, data: { pastDueSince: null } });
			}
		}
		return i;
	});
	await emit(`invoice.${status}`, { invoiceId: updated.id, number: updated.number, clientId: updated.clientId });
	if (recovered) await emit("client.status_changed", { clientId: updated.clientId, status: "active" });
	const client = await prisma.client.findUnique({ where: { id: updated.clientId }, include: { storefronts: true } });
	res.json({ invoice: invoiceOut(updated), client: client ? clientOut(client) : null });
});

/* ─── Support tickets ─────────────────────────────────────────────────────── */

export const ticketsRouter = Router();

ticketsRouter.patch("/:id", requirePermission("support.write"), async (req, res) => {
	const body = ticketPatchSchema.parse(req.body);
	const ticket = await prisma.ticket.findUnique({ where: { id: String(req.params.id) } });
	if (!ticket) throw notFound("Ticket");
	if (!body.status && !body.priority && body.assigneeId === undefined && !body.reply) throw badRequest("Nothing to update.");
	if (body.assigneeId && !(await prisma.staff.findUnique({ where: { id: body.assigneeId } }))) throw badRequest("Unknown team member.");
	const staff = req.staff!;
	const changed = (["status", "priority", "assigneeId"] as const).filter((k) => body[k] !== undefined && body[k] !== ticket[k]);
	const updated = await prisma.$transaction(async (tx) => {
		const t = await tx.ticket.update({
			where: { id: ticket.id },
			data: {
				status: body.status,
				priority: body.priority,
				assigneeId: body.assigneeId === undefined ? undefined : body.assigneeId,
				updatedAt: new Date(),
				...(body.reply ? { messages: { create: { author: staff.name, fromClient: false, body: body.reply } } } : {}),
			},
			include: { messages: true },
		});
		await audit(tx, actorOf(req), {
			action: body.reply ? "ticket.replied" : "ticket.updated",
			entityType: "ticket",
			entityId: t.id,
			entityName: `#${t.number}`,
			summary: [body.reply ? "Replied to ticket" : "", changed.length ? `Updated ${changed.join(", ")}` : ""].filter(Boolean).join("; ") || "Updated ticket",
		});
		return t;
	});
	if (body.reply) {
		const client = await prisma.client.findUnique({ where: { id: ticket.clientId } });
		const contact = client?.contact as ClientContact | undefined;
		if (contact?.email) await sendMail(contact.email, `Re: [#${ticket.number}] ${ticket.subject}`, `${body.reply}\n\n— ${staff.name}`);
		await emit("ticket.replied", { ticketId: ticket.id, number: ticket.number, clientId: ticket.clientId });
	}
	res.json({ ticket: ticketOut(updated) });
});
