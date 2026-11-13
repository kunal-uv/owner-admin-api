import type { PrismaClient } from "@prisma/client";
import type { FeatureDef, PlatformSettings, WebsiteConfig } from "./types.js";

/**
 * What a fresh platform starts with. No clients, plans, leads, invoices or
 * tickets — those are created in the console. The one product is RentBuddyz,
 * with the modules its admin actually has (RentBuddyAdmin's sidebar).
 */

export const RENTBUDDYZ_FEATURES: FeatureDef[] = [
	{ key: "dashboard", name: "Dashboard", group: "Core", core: true },
	{ key: "orders", name: "Order management", group: "Core", core: true },
	{ key: "customers", name: "Customers", group: "Core", core: true },
	{ key: "inventory", name: "Master products & inventory", group: "Core", core: true },
	{ key: "categories", name: "Categories", group: "Core", core: true },
	{ key: "transactions", name: "Transactions", group: "Core", core: true },
	{ key: "reservations", name: "Reserve & hold", group: "Rentals" },
	{ key: "rentals", name: "Rental management", group: "Rentals" },
	{ key: "returns", name: "Return & replacement", group: "Rentals" },
	{ key: "tags", name: "Tags", group: "Catalogue" },
	{ key: "warranties", name: "Warranty", group: "Catalogue" },
	{ key: "product_sets", name: "Sets", group: "Catalogue" },
	{ key: "banners", name: "Banners", group: "Marketing" },
	{ key: "promotional_tags", name: "Promotional tags", group: "Marketing" },
	{ key: "ratings", name: "Reviews & ratings", group: "Marketing" },
	{ key: "website_customization", name: "Website customization", group: "Marketing" },
	{ key: "pos", name: "In-store POS", group: "Operations" },
	{ key: "reports", name: "Reports", group: "Operations" },
	{ key: "support_center", name: "Support center", group: "Operations" },
	{ key: "attendance", name: "Attendance", group: "Operations" },
	{ key: "commissions", name: "Commissions", group: "Operations" },
	{ key: "stores", name: "Active stores (more than one)", group: "Administration" },
	{ key: "user_management", name: "User management & roles", group: "Administration" },
	{ key: "custom_domain", name: "Custom storefront domain", group: "Administration" },
];

export const defaultSettings = (ownerEmail: string): PlatformSettings => ({
	brandName: "Platform",
	consoleSubtitle: "Super admin",
	supportEmail: ownerEmail,
	billingEmail: ownerEmail,
	rootDomain: "unlockvelocity.in",
	defaultCurrency: "USD",
	taxRatePct: 0,
	invoicePrefix: "INV-",
	paymentTermsDays: 14,
	dunning: { retryEveryDays: 3, suspendAfterDays: 14, cancelAfterDays: 45 },
	security: { enforce2fa: false, sessionHours: 8, ipAllowlist: "", impersonationNeedsReason: true },
	maintenanceMode: false,
	webhookUrl: "",
});

export const defaultWebsite = (featuredProductId: string): WebsiteConfig => ({
	headline: "",
	subheadline: "",
	announcement: "",
	announcementEnabled: false,
	showPricing: true,
	yearlyDiscountLabel: "",
	leadFormEnabled: true,
	selfServeSignup: false,
	featuredProductId,
	faqs: [],
});

/** Creates the settings, the marketing-site document and the RentBuddyz product if they're missing. Never overwrites. */
export async function ensurePlatform(prisma: PrismaClient, ownerEmail: string) {
	const product = await prisma.product.upsert({
		where: { key: "rentbuddyz" },
		update: {},
		create: {
			id: "prd_rentbuddyz",
			key: "rentbuddyz",
			name: "RentBuddyz",
			tagline: "Rental commerce, store operations and storefront in one admin.",
			status: "live",
			color: "#299c8e",
			adminHostPattern: "{slug}-admin.unlockvelocity.in",
			storefrontHostPattern: "{slug}.unlockvelocity.in",
			features: RENTBUDDYZ_FEATURES as never,
		},
	});
	if (!(await prisma.document.findUnique({ where: { key: "settings" } }))) {
		await prisma.document.create({ data: { key: "settings", data: defaultSettings(ownerEmail) as never } });
	}
	if (!(await prisma.document.findUnique({ where: { key: "website" } }))) {
		await prisma.document.create({ data: { key: "website", data: defaultWebsite(product.id) as never } });
	}
	return product;
}
