import type { Client, Plan } from "@prisma/client";
import type { Tx } from "../db.js";
import { id } from "./crypto.js";
import { addDays, cyclePriceCents } from "./domain.js";
import { nextCounter } from "./documents.js";
import type { BillingCycle, PlatformSettings } from "./types.js";

export interface InvoiceDraft {
	description: string;
	amountCents: number;
	periodStart: Date;
	periodEnd: Date;
}

/**
 * Creates an open invoice for a client. Discount and tax come from the client
 * and platform settings. Nothing is issued for a zero amount (free plans), so
 * a free client never has an invoice that could go overdue.
 */
export async function issueInvoice(tx: Tx, client: Pick<Client, "id" | "name" | "discountPct">, currency: string, settings: PlatformSettings, draft: InvoiceDraft, now = new Date()) {
	const subtotalCents = Math.max(0, Math.round(draft.amountCents));
	if (subtotalCents === 0) return null;
	const discountCents = Math.round((subtotalCents * Math.min(100, Math.max(0, client.discountPct))) / 100);
	const taxCents = Math.round(((subtotalCents - discountCents) * Math.max(0, settings.taxRatePct)) / 100);
	const seq = await nextCounter(tx, "invoice", 1001);
	return tx.invoice.create({
		data: {
			id: id("inv"),
			number: `${settings.invoicePrefix}${seq}`,
			clientId: client.id,
			clientName: client.name,
			currency,
			lines: [{ description: draft.description, amountCents: subtotalCents }],
			subtotalCents,
			discountCents,
			taxCents,
			totalCents: subtotalCents - discountCents + taxCents,
			status: "open",
			issuedAt: now,
			dueAt: addDays(now, Math.max(0, settings.paymentTermsDays)),
			periodStart: draft.periodStart,
			periodEnd: draft.periodEnd,
		},
	});
}

export const planLine = (productName: string, plan: Pick<Plan, "name">, cycle: BillingCycle) => `${productName} ${plan.name} — ${cycle}`;

export const periodPrice = (plan: Pick<Plan, "priceMonthlyCents" | "priceYearlyCents">, cycle: BillingCycle) => cyclePriceCents(plan, cycle);
