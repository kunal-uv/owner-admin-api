import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { toCents } from "../../src/lib/domain.js";
import { createSeed } from "./demo-fixture.js";

const TABLES = [
	"ticket_messages",
	"tickets",
	"domains",
	"usage_snapshots",
	"clients",
	"plans",
	"products",
	"leads",
	"invoices",
	"staff_sessions",
	"staff_tokens",
	"staff",
	"impersonation_tokens",
	"audit_log",
	"documents",
	"counters",
	"webhook_deliveries",
	"email_outbox",
];

export async function wipe(prisma: PrismaClient) {
	await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

/** Loads the demo dataset. With `wipe`, everything in the database is deleted first. */
export async function seedDemo(prisma: PrismaClient, opts: { wipe?: boolean; password?: string } = {}) {
	if (opts.wipe) await wipe(prisma);
	const fx = createSeed();
	const now = Date.now();
	const passwordHash = await bcrypt.hash(opts.password ?? "test-password-123", 10);

	// A past-due client's overdue invoice must actually be past its due date.
	for (const inv of fx.invoices) {
		if (inv.status === "overdue" && new Date(inv.dueAt).getTime() >= now) {
			inv.dueAt = new Date(now - 6 * 86_400_000).toISOString();
			inv.issuedAt = new Date(now - 20 * 86_400_000).toISOString();
		}
	}

	await prisma.$transaction(
		async (tx) => {
			await tx.product.createMany({
				data: fx.products.map((p) => ({ ...p, features: p.features as never, createdAt: new Date(p.createdAt), serviceKeyHint: undefined })),
			});
			await tx.plan.createMany({
				data: fx.plans.map(({ priceMonthly, priceYearly, createdAt, highlighted, ...p }) => ({
					...p,
					highlighted: !!highlighted,
					priceMonthlyCents: toCents(priceMonthly),
					priceYearlyCents: toCents(priceYearly),
					limits: p.limits as never,
					createdAt: new Date(createdAt),
				})),
			});
			for (const c of fx.clients) {
				const overdue = fx.invoices.find((i) => i.clientId === c.id && i.status === "overdue");
				await tx.client.create({
					data: {
						id: c.id,
						name: c.name,
						slug: c.slug,
						productId: c.productId,
						planId: c.planId,
						status: c.status,
						billingCycle: c.billingCycle,
						contact: c.contact as never,
						company: c.company as never,
						adminHost: c.adminHost,
						featureOverrides: c.featureOverrides,
						limitOverrides: c.limitOverrides as never,
						discountPct: c.discountPct,
						usage: c.usage as never,
						trialEndsAt: c.trialEndsAt ? new Date(c.trialEndsAt) : null,
						currentPeriodStart: new Date(c.currentPeriodStart),
						currentPeriodEnd: new Date(c.currentPeriodEnd),
						pastDueSince: c.status === "past_due" && overdue ? new Date(overdue.dueAt) : null,
						// No made-up results: the first real health check fills this in.
						health: { state: "unknown" },
						tags: c.tags,
						notes: c.notes,
						createdAt: new Date(c.createdAt),
						storefronts: { create: c.storefronts.map((s, i) => ({ ...s, sortOrder: i })) },
					},
				});
			}
			await tx.lead.createMany({
				data: fx.leads.map((l) => ({ ...l, planId: l.planId ?? null, assigneeId: l.assigneeId ?? null, clientId: l.clientId ?? null, lostReason: l.lostReason ?? null, createdAt: new Date(l.createdAt) })),
			});
			await tx.invoice.createMany({
				data: fx.invoices.map((i) => ({
					id: i.id,
					number: i.number,
					clientId: i.clientId,
					clientName: fx.clients.find((c) => c.id === i.clientId)?.name ?? "",
					currency: i.currency,
					lines: i.lines.map((l) => ({ description: l.description, amountCents: toCents(l.amount) })),
					subtotalCents: toCents(i.subtotal),
					discountCents: toCents(i.discount),
					taxCents: toCents(i.tax),
					totalCents: toCents(i.subtotal) - toCents(i.discount) + toCents(i.tax),
					status: i.status,
					issuedAt: new Date(i.issuedAt),
					dueAt: new Date(i.dueAt),
					paidAt: i.paidAt ? new Date(i.paidAt) : null,
					periodStart: new Date(i.periodStart),
					periodEnd: new Date(i.periodEnd),
				})),
			});
			for (const t of fx.tickets) {
				await tx.ticket.create({
					data: {
						id: t.id,
						number: t.number,
						clientId: t.clientId,
						subject: t.subject,
						status: t.status,
						priority: t.priority,
						createdAt: new Date(t.createdAt),
						updatedAt: new Date(t.updatedAt),
						messages: { create: t.messages.map((m) => ({ at: new Date(m.at), author: m.author, fromClient: m.fromClient, body: m.body })) },
					},
				});
			}
			await tx.staff.createMany({
				data: fx.staff.map((s) => ({
					id: s.id,
					name: s.name,
					email: s.email.toLowerCase(),
					role: s.role,
					status: s.status,
					passwordHash: s.status === "active" ? passwordHash : null,
					mfaEnabled: false,
					lastActiveAt: s.lastActiveAt ? new Date(s.lastActiveAt) : null,
					createdAt: new Date(s.createdAt),
				})),
			});
			await tx.auditEntry.createMany({
				data: fx.audit.map((a) => ({ ...a, at: new Date(a.at) })),
			});
			await tx.document.createMany({
				data: [
					{ key: "settings", data: fx.settings as never },
					{ key: "website", data: fx.website as never },
				],
			});
			const maxInvoice = Math.max(1000, ...fx.invoices.map((i) => Number(i.number.replace(/\D/g, "")) || 0));
			const maxTicket = Math.max(300, ...fx.tickets.map((t) => t.number));
			await tx.counter.createMany({
				data: [
					{ name: "invoice", value: maxInvoice },
					{ name: "ticket", value: maxTicket },
				],
			});
		},
		{ timeout: 30_000 },
	);
}
