import { z } from "zod";
import { HOST_RE, LIMIT_KEYS, SLUG_RE } from "./domain.js";

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => z.string().trim().min(1, "Required").max(max);
export const email = z.string().trim().toLowerCase().email("Enter a valid email").max(200);
const emailOrEmpty = z.union([z.literal(""), email]);
const host = z.string().trim().toLowerCase().regex(HOST_RE, "Enter a hostname like shop.example.com");
const limitValue = z.number().finite().min(-1);

export const limitsSchema = z.object({
	stores: limitValue.int(),
	staffUsers: limitValue.int(),
	products: limitValue.int(),
	ordersPerMonth: limitValue.int(),
	storageGb: limitValue,
});

export const limitOverridesSchema = z
	.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue.optional()])) as Record<(typeof LIMIT_KEYS)[number], z.ZodOptional<typeof limitValue>>)
	.strict();

export const contactSchema = z.object({ name: text(120), email: emailOrEmpty, phone: text(40) });

export const companySchema = z.object({
	legalName: text(200),
	country: text(60),
	timezone: text(60),
	currency: z.string().trim().toUpperCase().length(3),
	taxId: text(60),
	address: text(400),
});

export const storefrontSchema = z.object({
	host,
	verified: z.boolean(),
	primary: z.boolean(),
	sslStatus: z.enum(["active", "pending", "failed"]),
});

export const clientCreateSchema = z.object({
	name: required(120),
	slug: z.string().trim().toLowerCase().regex(SLUG_RE, "3–40 lowercase letters, numbers or dashes"),
	productId: z.string().min(1),
	planId: z.string().min(1),
	billingCycle: z.enum(["monthly", "yearly"]),
	trialDays: z.number().int().min(0).max(90),
	contact: contactSchema.extend({ name: required(120), email }),
	company: companySchema.partial({ taxId: true, address: true }),
	notes: text(4000).default(""),
	leadId: z.string().optional(),
	apiBaseUrl: z.union([z.literal(""), z.string().trim().url().max(500)]).optional(),
	platformKey: z.union([z.literal(""), z.string().trim().min(32, "A platform key is at least 32 characters").max(500)]).optional(),
});

export const clientPatchSchema = z
	.object({
		name: required(120),
		contact: contactSchema,
		company: companySchema,
		adminHost: host,
		storefronts: z.array(storefrontSchema).max(20),
		featureOverrides: z.record(z.string().max(60), z.boolean()),
		limitOverrides: limitOverridesSchema,
		discountPct: z.number().min(0).max(100),
		tags: z.array(z.string().trim().min(1).max(40)).max(20),
		notes: text(4000),
		healthUrl: z.union([z.literal(""), z.string().trim().url().max(500)]),
		apiBaseUrl: z.union([z.literal(""), z.string().trim().url().max(500)]),
		/** Write-only. "" removes the stored key. */
		platformKey: z.union([z.literal(""), z.string().trim().min(32, "A platform key is at least 32 characters").max(500)]),
	})
	.partial()
	.strict();

export const statusChangeSchema = z.object({
	status: z.enum(["active", "suspended", "cancelled"]),
	reason: text(500).optional(),
});

export const planChangeSchema = z.object({ planId: z.string().min(1), billingCycle: z.enum(["monthly", "yearly"]) });

export const featureSchema = z.object({
	key: z.string().trim().regex(/^[a-z0-9_]{2,60}$/, "Lowercase letters, numbers and underscores"),
	name: required(80),
	group: required(40),
	description: text(300).optional(),
	core: z.boolean().optional(),
});

export const productSchema = z.object({
	key: z.string().trim().regex(/^[a-z0-9-]{2,40}$/, "Lowercase letters, numbers and dashes"),
	name: required(80),
	tagline: text(200),
	status: z.enum(["live", "beta", "coming_soon", "retired"]),
	color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #2563eb"),
	adminHostPattern: z.string().trim().max(200).refine((v) => v.includes("{slug}"), "Must contain {slug}"),
	storefrontHostPattern: z.string().trim().max(200).refine((v) => v.includes("{slug}"), "Must contain {slug}"),
	features: z
		.array(featureSchema)
		.min(1)
		.max(200)
		.refine((list) => new Set(list.map((f) => f.key)).size === list.length, "Feature keys must be unique"),
});

export const planSchema = z.object({
	productId: z.string().min(1),
	name: required(60),
	code: z.string().trim().regex(/^[a-z0-9-]{2,60}$/, "Lowercase letters, numbers and dashes"),
	description: text(500),
	currency: z.string().trim().toUpperCase().length(3),
	priceMonthly: z.number().min(0).max(1_000_000),
	priceYearly: z.number().min(0).max(10_000_000),
	trialDays: z.number().int().min(0).max(90),
	limits: limitsSchema,
	features: z.array(z.string().max(60)).max(200),
	isPublic: z.boolean(),
	highlighted: z.boolean().optional(),
	sortOrder: z.number().int().min(0).max(1000),
});

export const leadSchema = z.object({
	name: required(120),
	company: text(160),
	email,
	phone: text(40),
	productId: z.string().min(1),
	planId: z.string().min(1).nullish(),
	source: z.enum(["website", "referral", "sales", "event", "partner"]),
	status: z.enum(["new", "contacted", "demo_scheduled", "won", "lost"]),
	message: text(4000),
	assigneeId: z.string().min(1).nullish(),
	lostReason: text(500).nullish(),
});

export const publicLeadSchema = z.object({
	name: required(120),
	company: text(160).default(""),
	email,
	phone: text(40).default(""),
	product: z.string().trim().max(40).optional(),
	plan: z.string().trim().max(60).optional(),
	message: text(4000).default(""),
	/** Honeypot: real visitors never fill this in. */
	website: z.string().max(500).optional(),
});

export const ticketPatchSchema = z
	.object({
		status: z.enum(["open", "pending", "resolved"]).optional(),
		priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
		assigneeId: z.string().nullish(),
		reply: text(10_000).optional(),
	})
	.strict();

export const staffInviteSchema = z.object({ name: required(120), email, role: z.enum(["owner", "admin", "billing", "support", "viewer"]) });

export const staffPatchSchema = z
	.object({
		name: required(120),
		role: z.enum(["owner", "admin", "billing", "support", "viewer"]),
		status: z.enum(["active", "disabled"]),
	})
	.partial()
	.strict();

export const password = z.string().min(10, "Use at least 10 characters").max(200);

export const websiteSchema = z.object({
	headline: text(160),
	subheadline: text(400),
	announcement: text(200),
	announcementEnabled: z.boolean(),
	showPricing: z.boolean(),
	yearlyDiscountLabel: text(60),
	leadFormEnabled: z.boolean(),
	selfServeSignup: z.boolean(),
	featuredProductId: z.string().min(1),
	faqs: z.array(z.object({ q: text(300), a: text(2000) })).max(50),
});

export const settingsSchema = z.object({
	brandName: required(60),
	consoleSubtitle: text(60),
	supportEmail: email,
	billingEmail: email,
	rootDomain: host,
	defaultCurrency: z.string().trim().toUpperCase().length(3),
	taxRatePct: z.number().min(0).max(50),
	invoicePrefix: z.string().trim().max(12).regex(/^[A-Za-z0-9-]*$/, "Letters, numbers and dashes only"),
	paymentTermsDays: z.number().int().min(0).max(120),
	dunning: z
		.object({
			retryEveryDays: z.number().int().min(1).max(30),
			suspendAfterDays: z.number().int().min(1).max(180),
			cancelAfterDays: z.number().int().min(2).max(365),
		})
		.refine((d) => d.cancelAfterDays > d.suspendAfterDays, { message: "Cancel must come after suspend", path: ["cancelAfterDays"] }),
	security: z.object({
		enforce2fa: z.boolean(),
		sessionHours: z.number().int().min(1).max(72),
		ipAllowlist: text(4000),
		impersonationNeedsReason: z.boolean(),
	}),
	maintenanceMode: z.boolean(),
	webhookUrl: z.union([z.literal(""), z.string().trim().url().max(500)]),
});

export const usageSchema = z.object({
	stores: z.number().int().min(0),
	staffUsers: z.number().int().min(0),
	products: z.number().int().min(0),
	ordersPerMonth: z.number().int().min(0),
	storageGb: z.number().min(0),
});

export const tenantTicketSchema = z.object({
	subject: required(200),
	body: required(10_000),
	author: required(120),
	priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
});

export const tenantMessageSchema = z.object({ body: required(10_000), author: required(120) });
