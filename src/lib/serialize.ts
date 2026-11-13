import type {
	AuditEntry as DbAudit,
	Client as DbClient,
	Domain as DbDomain,
	Invoice as DbInvoice,
	Lead as DbLead,
	Plan as DbPlan,
	Product as DbProduct,
	Staff as DbStaff,
	Ticket as DbTicket,
	TicketMessage as DbTicketMessage,
} from "@prisma/client";
import { fromCents } from "./domain.js";
import type {
	AuditEntry,
	BillingCycle,
	Client,
	FeatureDef,
	Invoice,
	Lead,
	Limits,
	Plan,
	Product,
	StaffMember,
	Ticket,
} from "./types.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);

export const productOut = (p: DbProduct): Product => ({
	id: p.id,
	key: p.key,
	name: p.name,
	tagline: p.tagline,
	status: p.status as Product["status"],
	color: p.color,
	adminHostPattern: p.adminHostPattern,
	storefrontHostPattern: p.storefrontHostPattern,
	features: p.features as unknown as FeatureDef[],
	serviceKeyHint: p.serviceKeyHint ?? undefined,
	createdAt: p.createdAt.toISOString(),
});

export const planOut = (p: DbPlan): Plan => ({
	id: p.id,
	productId: p.productId,
	name: p.name,
	code: p.code,
	description: p.description,
	currency: p.currency,
	priceMonthly: fromCents(p.priceMonthlyCents),
	priceYearly: fromCents(p.priceYearlyCents),
	trialDays: p.trialDays,
	limits: p.limits as unknown as Limits,
	features: p.features,
	status: p.status as Plan["status"],
	isPublic: p.isPublic,
	highlighted: p.highlighted,
	sortOrder: p.sortOrder,
	createdAt: p.createdAt.toISOString(),
});

export const clientOut = (c: DbClient & { storefronts: DbDomain[] }): Client => ({
	id: c.id,
	name: c.name,
	slug: c.slug,
	productId: c.productId,
	planId: c.planId,
	pendingPlanId: c.pendingPlanId ?? undefined,
	pendingBillingCycle: (c.pendingBillingCycle as BillingCycle | null) ?? undefined,
	status: c.status as Client["status"],
	billingCycle: c.billingCycle as BillingCycle,
	contact: c.contact as unknown as Client["contact"],
	company: c.company as unknown as Client["company"],
	adminHost: c.adminHost,
	storefronts: [...c.storefronts]
		.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime())
		.map((d) => ({ host: d.host, verified: d.verified, primary: d.primary, sslStatus: d.sslStatus as "active" | "pending" | "failed" })),
	featureOverrides: c.featureOverrides as Record<string, boolean>,
	limitOverrides: c.limitOverrides as Partial<Limits>,
	discountPct: c.discountPct,
	usage: c.usage as unknown as Client["usage"],
	usageReportedAt: iso(c.usageReportedAt),
	trialEndsAt: iso(c.trialEndsAt),
	currentPeriodStart: c.currentPeriodStart.toISOString(),
	currentPeriodEnd: c.currentPeriodEnd.toISOString(),
	cancelAt: iso(c.cancelAt),
	suspendedReason: c.suspendedReason ?? undefined,
	health: c.health as unknown as Client["health"],
	healthUrl: c.healthUrl ?? undefined,
	apiBaseUrl: c.apiBaseUrl ?? undefined,
	platformKeyHint: c.platformKeyHint ?? undefined,
	tags: c.tags,
	notes: c.notes,
	createdAt: c.createdAt.toISOString(),
	leadId: c.leadId ?? undefined,
});

export const leadOut = (l: DbLead): Lead => ({
	id: l.id,
	name: l.name,
	company: l.company,
	email: l.email,
	phone: l.phone,
	productId: l.productId,
	planId: l.planId ?? undefined,
	source: l.source as Lead["source"],
	status: l.status as Lead["status"],
	message: l.message,
	createdAt: l.createdAt.toISOString(),
	assigneeId: l.assigneeId ?? undefined,
	clientId: l.clientId ?? undefined,
	lostReason: l.lostReason ?? undefined,
});

export const invoiceOut = (i: DbInvoice): Invoice => ({
	id: i.id,
	number: i.number,
	clientId: i.clientId,
	currency: i.currency,
	lines: (i.lines as { description: string; amountCents: number }[]).map((l) => ({ description: l.description, amount: fromCents(l.amountCents) })),
	subtotal: fromCents(i.subtotalCents),
	discount: fromCents(i.discountCents),
	tax: fromCents(i.taxCents),
	total: fromCents(i.totalCents),
	status: i.status as Invoice["status"],
	issuedAt: i.issuedAt.toISOString(),
	dueAt: i.dueAt.toISOString(),
	paidAt: iso(i.paidAt),
	periodStart: i.periodStart.toISOString(),
	periodEnd: i.periodEnd.toISOString(),
});

export const ticketOut = (t: DbTicket & { messages: DbTicketMessage[] }): Ticket => ({
	id: t.id,
	number: t.number,
	clientId: t.clientId,
	subject: t.subject,
	status: t.status as Ticket["status"],
	priority: t.priority as Ticket["priority"],
	assigneeId: t.assigneeId ?? undefined,
	createdAt: t.createdAt.toISOString(),
	updatedAt: t.updatedAt.toISOString(),
	messages: [...t.messages]
		.sort((a, b) => a.at.getTime() - b.at.getTime())
		.map((m) => ({ id: m.id, at: m.at.toISOString(), author: m.author, fromClient: m.fromClient, body: m.body })),
});

/** Never includes password hashes or MFA secrets. */
export const staffOut = (s: DbStaff): StaffMember => ({
	id: s.id,
	name: s.name,
	email: s.email,
	role: s.role as StaffMember["role"],
	status: s.status as StaffMember["status"],
	twoFactor: s.mfaEnabled,
	lastActiveAt: iso(s.lastActiveAt),
	createdAt: s.createdAt.toISOString(),
});

export const auditOut = (a: DbAudit): AuditEntry => ({
	id: a.id,
	at: a.at.toISOString(),
	actorId: a.actorId,
	actorName: a.actorName,
	action: a.action,
	entityType: a.entityType as AuditEntry["entityType"],
	entityId: a.entityId ?? undefined,
	entityName: a.entityName ?? undefined,
	summary: a.summary,
	reason: a.reason ?? undefined,
});
