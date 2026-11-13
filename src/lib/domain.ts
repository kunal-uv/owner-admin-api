import type { BillingCycle, Client, Limits, Plan, Product, StaffRole } from "./types.js";

export const LIMIT_KEYS = ["stores", "staffUsers", "products", "ordersPerMonth", "storageGb"] as const;
export const RESERVED_SLUGS = new Set(["www", "admin", "api", "app", "mail", "status", "docs", "owner", "platform"]);
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/;
export const HOST_RE = /^(?=.{4,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const toCents = (amount: number) => Math.round(amount * 100);
export const fromCents = (cents: number) => Math.round(cents) / 100;

/* ─── Periods ─────────────────────────────────────────────────────────────── */

export function addCycle(from: Date, cycle: BillingCycle): Date {
	const d = new Date(from);
	if (cycle === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
	else d.setUTCMonth(d.getUTCMonth() + 1);
	return d;
}

export const addDays = (from: Date, days: number) => new Date(from.getTime() + days * 86_400_000);

/* ─── Entitlements ────────────────────────────────────────────────────────── */

export function effectiveFeatures(product: Pick<Product, "features"> | undefined, plan: Pick<Plan, "features"> | undefined, overrides: Record<string, boolean>) {
	const enabled = new Set(plan?.features ?? []);
	for (const [key, on] of Object.entries(overrides)) {
		if (on) enabled.add(key);
		else enabled.delete(key);
	}
	product?.features.filter((f) => f.core).forEach((f) => enabled.add(f.key));
	return enabled;
}

export function effectiveLimits(planLimits: Limits | undefined, overrides: Partial<Limits>): Limits {
	const base: Limits = planLimits ?? { stores: 0, staffUsers: 0, products: 0, ordersPerMonth: 0, storageGb: 0 };
	return { ...base, ...overrides };
}

export function entitlementPayload(client: Client, plan: Plan | undefined, product: Product | undefined, maintenance: boolean) {
	return {
		tenant: client.slug,
		product: product?.key,
		status: client.status,
		plan: plan?.code,
		features: Array.from(effectiveFeatures(product, plan, client.featureOverrides)).sort(),
		limits: effectiveLimits(plan?.limits, client.limitOverrides),
		trialEndsAt: client.trialEndsAt ?? null,
		currentPeriodEnd: client.currentPeriodEnd,
		readOnly: ["suspended", "cancelled"].includes(client.status),
		maintenance,
		adminHost: client.adminHost,
		storefronts: client.storefronts.filter((s) => s.verified).map((s) => ({ host: s.host, primary: s.primary })),
	};
}

/** Monthly-equivalent price in cents, used to decide upgrade vs downgrade. */
export const monthlyEquivalentCents = (plan: { priceMonthlyCents: number; priceYearlyCents: number }, cycle: BillingCycle) =>
	cycle === "yearly" ? plan.priceYearlyCents / 12 : plan.priceMonthlyCents;

export const cyclePriceCents = (plan: { priceMonthlyCents: number; priceYearlyCents: number }, cycle: BillingCycle) =>
	cycle === "yearly" ? plan.priceYearlyCents : plan.priceMonthlyCents;

/* ─── Staff permissions (mirrors the console) ─────────────────────────────── */

export type Permission =
	| "clients.write"
	| "clients.lifecycle"
	| "clients.impersonate"
	| "plans.write"
	| "products.write"
	| "billing.write"
	| "leads.write"
	| "support.write"
	| "website.write"
	| "settings.write"
	| "team.write";

const matrix: Record<StaffRole, Permission[] | "*"> = {
	owner: "*",
	admin: [
		"clients.write",
		"clients.lifecycle",
		"clients.impersonate",
		"plans.write",
		"products.write",
		"billing.write",
		"leads.write",
		"support.write",
		"website.write",
	],
	billing: ["billing.write", "plans.write", "clients.lifecycle"],
	support: ["support.write", "clients.impersonate", "leads.write"],
	viewer: [],
};

export const STAFF_ROLES = Object.keys(matrix) as StaffRole[];

export const can = (role: string | undefined, permission: Permission) => {
	const allowed = role ? matrix[role as StaffRole] : undefined;
	if (!allowed) return false;
	return allowed === "*" || allowed.includes(permission);
};
