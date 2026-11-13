import { prisma } from "../db.js";
import { audit, SYSTEM } from "./audit.js";
import { issueInvoice, planLine, periodPrice } from "./billing.js";
import { addCycle } from "./domain.js";
import { getSettings } from "./documents.js";
import { emit } from "./events.js";
import { sendMail } from "./mail.js";
import type { BillingCycle, ClientContact } from "./types.js";

const DAY = 86_400_000;

export interface LifecycleReport {
	overdueInvoices: number;
	pastDue: number;
	suspended: number;
	cancelled: number;
	trialsEnded: number;
	renewed: number;
}

/**
 * Scheduled billing lifecycle. Safe to run any number of times: every step
 * only acts on rows that are still in the state it is looking for.
 */
export async function runLifecycle(now = new Date()): Promise<LifecycleReport> {
	const settings = await getSettings();
	const report: LifecycleReport = { overdueInvoices: 0, pastDue: 0, suspended: 0, cancelled: 0, trialsEnded: 0, renewed: 0 };

	/* 1. Open invoices past their due date become overdue; their clients go past due. */
	const late = await prisma.invoice.findMany({ where: { status: "open", dueAt: { lt: now } } });
	for (const inv of late) {
		const client = await prisma.client.findUnique({ where: { id: inv.clientId } });
		const becamePastDue = await prisma.$transaction(async (tx) => {
			const updated = await tx.invoice.updateMany({ where: { id: inv.id, status: "open" }, data: { status: "overdue" } });
			if (!updated.count) return false;
			await audit(tx, SYSTEM, { action: "invoice.overdue", entityType: "invoice", entityId: inv.id, entityName: inv.number, summary: `${inv.number} is overdue` });
			if (client && client.status === "active") {
				await tx.client.update({ where: { id: client.id }, data: { status: "past_due", pastDueSince: inv.dueAt } });
				await audit(tx, SYSTEM, { action: "client.past_due", entityType: "client", entityId: client.id, entityName: client.name, summary: `Payment overdue (${inv.number}) — marked past due` });
				return true;
			}
			return false;
		});
		report.overdueInvoices += 1;
		if (client) {
			const contact = client.contact as unknown as ClientContact;
			if (contact.email) {
				await sendMail(
					contact.email,
					`Payment overdue: ${inv.number}`,
					`Hi ${contact.name || client.name},\n\nInvoice ${inv.number} for ${(inv.totalCents / 100).toFixed(2)} ${inv.currency} was due on ${inv.dueAt.toDateString()} and is still unpaid.\n\nIf it isn't paid within ${settings.dunning.suspendAfterDays} days of the due date the account will be suspended.\nQuestions? Reply to ${settings.billingEmail}.`,
				);
			}
		}
		if (becamePastDue && client) {
			report.pastDue += 1;
			await emit("client.status_changed", { clientId: client.id, slug: client.slug, status: "past_due" });
		}
	}

	/* 2. Dunning: past due → suspended → cancelled. */
	const dunned = await prisma.client.findMany({ where: { status: { in: ["past_due", "suspended"] }, pastDueSince: { not: null } } });
	for (const c of dunned) {
		const days = Math.floor((now.getTime() - c.pastDueSince!.getTime()) / DAY);
		let next: "suspended" | "cancelled" | null = null;
		if (days >= settings.dunning.cancelAfterDays) next = "cancelled";
		else if (c.status === "past_due" && days >= settings.dunning.suspendAfterDays) next = "suspended";
		if (!next) continue;
		const target = next;
		await prisma.$transaction(async (tx) => {
			await tx.client.update({
				where: { id: c.id },
				data: target === "cancelled" ? { status: "cancelled", cancelAt: now } : { status: "suspended", suspendedReason: "Unpaid invoices" },
			});
			await audit(tx, SYSTEM, {
				action: `client.${target}`,
				entityType: "client",
				entityId: c.id,
				entityName: c.name,
				summary: `${target === "cancelled" ? "Cancelled" : "Suspended"} after ${days} days overdue`,
				reason: "Dunning",
			});
		});
		report[target] += 1;
		const contact = c.contact as unknown as ClientContact;
		if (contact.email) {
			await sendMail(
				contact.email,
				target === "cancelled" ? "Your subscription has been cancelled" : "Your account has been suspended",
				`Hi ${contact.name || c.name},\n\nYour account has been ${target} because invoices are ${days} days overdue.\nPay the outstanding balance or contact ${settings.billingEmail} to restore access.`,
			);
		}
		await emit("client.status_changed", { clientId: c.id, slug: c.slug, status: target });
	}

	/* 3. Trials that ended without being converted. */
	const trials = await prisma.client.findMany({ where: { status: "trial", trialEndsAt: { lte: now } } });
	for (const c of trials) {
		await prisma.$transaction(async (tx) => {
			await tx.client.update({ where: { id: c.id }, data: { status: "suspended", suspendedReason: "Trial ended" } });
			await audit(tx, SYSTEM, { action: "client.suspended", entityType: "client", entityId: c.id, entityName: c.name, summary: "Trial ended without converting — suspended", reason: "Trial ended" });
		});
		report.trialsEnded += 1;
		const contact = c.contact as unknown as ClientContact;
		if (contact.email) {
			await sendMail(contact.email, "Your trial has ended", `Hi ${contact.name || c.name},\n\nYour free trial has ended and the account is paused. Contact ${settings.billingEmail} to choose a plan — your data is kept.`);
		}
		await emit("client.status_changed", { clientId: c.id, slug: c.slug, status: "suspended" });
	}

	/* 4. Renewals: roll the period forward, apply scheduled plan changes, invoice. */
	const due = await prisma.client.findMany({ where: { status: "active", currentPeriodEnd: { lte: now } }, include: { product: true } });
	for (const c of due) {
		let planId = c.pendingPlanId ?? c.planId;
		let cycle = (c.pendingBillingCycle ?? c.billingCycle) as BillingCycle;
		const plan = await prisma.plan.findUnique({ where: { id: planId } });
		if (!plan) {
			planId = c.planId;
			cycle = c.billingCycle as BillingCycle;
		}
		const effectivePlan = plan ?? (await prisma.plan.findUniqueOrThrow({ where: { id: c.planId } }));
		await prisma.$transaction(async (tx) => {
			let start = c.currentPeriodEnd;
			let end = addCycle(start, cycle);
			// Catch up if the job didn't run for a while — one invoice per missed period, at most 12.
			for (let i = 0; i < 12; i += 1) {
				await issueInvoice(tx, c, effectivePlan.currency, settings, {
					description: planLine(c.product.name, effectivePlan, cycle),
					amountCents: periodPrice(effectivePlan, cycle),
					periodStart: start,
					periodEnd: end,
				}, now);
				if (end > now) break;
				start = end;
				end = addCycle(start, cycle);
			}
			await tx.client.update({
				where: { id: c.id },
				data: { planId, billingCycle: cycle, pendingPlanId: null, pendingBillingCycle: null, currentPeriodStart: start, currentPeriodEnd: end },
			});
			const changed = planId !== c.planId || cycle !== c.billingCycle;
			await audit(tx, SYSTEM, {
				action: "client.renewed",
				entityType: "client",
				entityId: c.id,
				entityName: c.name,
				summary: `Renewed until ${end.toDateString()}${changed ? ` on ${effectivePlan.name} (${cycle}) — scheduled change applied` : ""}`,
			});
		});
		report.renewed += 1;
		await emit("client.renewed", { clientId: c.id, slug: c.slug });
	}

	return report;
}
