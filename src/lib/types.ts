/**
 * Domain model of the owner (platform / control-plane) console.
 *
 * Vocabulary:
 * - Product  — something we sell (RentBuddyz today, more later). Declares the
 *              catalogue of features its app knows how to switch on and off.
 * - Plan     — a priced bundle of one product's features + usage limits.
 * - Client   — a tenant: a business that subscribes to one product on one plan
 *              and gets its own admin address and storefront addresses.
 * - Lead     — a prospect captured from the website or by sales, convertible
 *              into a client.
 *
 * These shapes are the JSON contract between owner-admin-api and the owner
 * console. The same file lives in both projects — change them together.
 */

export type ID = string;
export type ISODate = string;

export type ProductStatus = "live" | "beta" | "coming_soon" | "retired";

export interface FeatureDef {
	key: string;
	name: string;
	group: string;
	description?: string;
	/** Core features are always on for every plan and cannot be overridden off. */
	core?: boolean;
}

export interface Product {
	id: ID;
	key: string;
	name: string;
	tagline: string;
	status: ProductStatus;
	color: string;
	/** Pattern for new tenants' admin hosts. `{slug}` is replaced. */
	adminHostPattern: string;
	storefrontHostPattern: string;
	features: FeatureDef[];
	/** Last 4 characters of the product's service key, if one has been issued. */
	serviceKeyHint?: string;
	createdAt: ISODate;
}

/** -1 means unlimited. */
export interface Limits {
	stores: number;
	staffUsers: number;
	products: number;
	ordersPerMonth: number;
	storageGb: number;
}

export type Usage = Limits;

export type PlanStatus = "active" | "archived";

export interface Plan {
	id: ID;
	productId: ID;
	name: string;
	code: string;
	description: string;
	currency: string;
	priceMonthly: number;
	priceYearly: number;
	trialDays: number;
	limits: Limits;
	features: string[];
	status: PlanStatus;
	/** Shown on the public pricing page. Private plans are sales-assigned only. */
	isPublic: boolean;
	highlighted?: boolean;
	sortOrder: number;
	createdAt: ISODate;
}

export type ClientStatus = "provisioning" | "trial" | "active" | "past_due" | "suspended" | "cancelled";
export type BillingCycle = "monthly" | "yearly";
export type HealthState = "up" | "degraded" | "down" | "unknown";

export interface StorefrontDomain {
	host: string;
	verified: boolean;
	primary: boolean;
	sslStatus: "active" | "pending" | "failed";
}

export interface ClientContact {
	name: string;
	email: string;
	phone: string;
}

export interface Client {
	id: ID;
	name: string;
	slug: string;
	productId: ID;
	planId: ID;
	/** Downgrade or billing-cycle change scheduled for the next renewal. */
	pendingPlanId?: ID;
	pendingBillingCycle?: BillingCycle;
	status: ClientStatus;
	billingCycle: BillingCycle;
	contact: ClientContact;
	company: {
		legalName: string;
		country: string;
		timezone: string;
		currency: string;
		taxId: string;
		address: string;
	};
	adminHost: string;
	storefronts: StorefrontDomain[];
	/** Per-tenant on/off overrides on top of the plan's feature list. */
	featureOverrides: Record<string, boolean>;
	/** Per-tenant limit overrides on top of the plan's limits. */
	limitOverrides: Partial<Limits>;
	/** Flat discount in percent applied to every invoice. */
	discountPct: number;
	usage: Usage;
	usageReportedAt?: ISODate;
	trialEndsAt?: ISODate;
	currentPeriodStart: ISODate;
	currentPeriodEnd: ISODate;
	cancelAt?: ISODate;
	suspendedReason?: string;
	health: { state: HealthState; latencyMs?: number; checkedAt?: ISODate; version?: string; error?: string };
	/** Overrides the default health URL ({apiBaseUrl origin}/health, else https://{adminHost}/api/health). */
	healthUrl?: string;
	/** Base URL of the client's product backend API, e.g. https://rent-buddy-api.example.com/api */
	apiBaseUrl?: string;
	/** Last 4 characters of the stored platform key, if one is set (the key itself never leaves the API). */
	platformKeyHint?: string;
	tags: string[];
	notes: string;
	createdAt: ISODate;
	leadId?: ID;
}

export type LeadStatus = "new" | "contacted" | "demo_scheduled" | "won" | "lost";
export type LeadSource = "website" | "referral" | "sales" | "event" | "partner";

export interface Lead {
	id: ID;
	name: string;
	company: string;
	email: string;
	phone: string;
	productId: ID;
	planId?: ID;
	source: LeadSource;
	status: LeadStatus;
	message: string;
	createdAt: ISODate;
	assigneeId?: ID;
	clientId?: ID;
	lostReason?: string;
}

export type InvoiceStatus = "draft" | "open" | "paid" | "overdue" | "void";

export interface InvoiceLine {
	description: string;
	amount: number;
}

export interface Invoice {
	id: ID;
	number: string;
	clientId: ID;
	currency: string;
	lines: InvoiceLine[];
	subtotal: number;
	discount: number;
	tax: number;
	total: number;
	status: InvoiceStatus;
	issuedAt: ISODate;
	dueAt: ISODate;
	paidAt?: ISODate;
	periodStart: ISODate;
	periodEnd: ISODate;
}

export type TicketStatus = "open" | "pending" | "resolved";
export type TicketPriority = "low" | "normal" | "high" | "urgent";

export interface TicketMessage {
	id: ID;
	at: ISODate;
	author: string;
	fromClient: boolean;
	body: string;
}

export interface Ticket {
	id: ID;
	number: number;
	clientId: ID;
	subject: string;
	status: TicketStatus;
	priority: TicketPriority;
	assigneeId?: ID;
	createdAt: ISODate;
	updatedAt: ISODate;
	messages: TicketMessage[];
}

export type StaffRole = "owner" | "admin" | "billing" | "support" | "viewer";

export interface StaffMember {
	id: ID;
	name: string;
	email: string;
	role: StaffRole;
	status: "active" | "invited" | "disabled";
	twoFactor: boolean;
	lastActiveAt?: ISODate;
	createdAt: ISODate;
}

export interface AuditEntry {
	id: ID;
	at: ISODate;
	actorId: ID;
	actorName: string;
	action: string;
	entityType: "client" | "plan" | "product" | "lead" | "invoice" | "ticket" | "staff" | "settings" | "website" | "session";
	entityId?: ID;
	entityName?: string;
	summary: string;
	reason?: string;
}

export interface WebsiteConfig {
	headline: string;
	subheadline: string;
	announcement: string;
	announcementEnabled: boolean;
	showPricing: boolean;
	yearlyDiscountLabel: string;
	leadFormEnabled: boolean;
	selfServeSignup: boolean;
	featuredProductId: ID;
	faqs: { q: string; a: string }[];
}

export interface PlatformSettings {
	brandName: string;
	consoleSubtitle: string;
	supportEmail: string;
	billingEmail: string;
	rootDomain: string;
	defaultCurrency: string;
	taxRatePct: number;
	invoicePrefix: string;
	paymentTermsDays: number;
	dunning: { retryEveryDays: number; suspendAfterDays: number; cancelAfterDays: number };
	security: { enforce2fa: boolean; sessionHours: number; ipAllowlist: string; impersonationNeedsReason: boolean };
	maintenanceMode: boolean;
	webhookUrl: string;
}

export interface Capabilities {
	/** Emails are delivered over SMTP (otherwise only logged). */
	smtp: boolean;
	/** SECRETS_KEY is configured, so platform keys can be stored. */
	secrets: boolean;
	/** Outgoing webhooks are signed and delivered. */
	webhooks: boolean;
	/** Two-factor sign-in is switched on (TWO_FACTOR=on). When off, the console hides every 2FA control. */
	twoFactor: boolean;
}

export interface Me extends StaffMember {
	/** Settings require 2FA and this account has not set it up yet. */
	mfaSetupRequired: boolean;
}

export interface Database {
	me: Me;
	capabilities: Capabilities;
	products: Product[];
	plans: Plan[];
	clients: Client[];
	leads: Lead[];
	invoices: Invoice[];
	tickets: Ticket[];
	staff: StaffMember[];
	audit: AuditEntry[];
	website: WebsiteConfig;
	settings: PlatformSettings;
}
