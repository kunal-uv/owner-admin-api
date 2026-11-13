import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import otplib from "otplib";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { prisma } from "../src/db.js";
import { invalidateSettingsCache, resetRateLimits } from "../src/lib/auth.js";
import { deliverWebhooks } from "../src/lib/events.js";
import { runLifecycle } from "../src/lib/lifecycle.js";
import { seedDemo } from "./fixtures/seed-data.js";

const PASSWORD = "test-password-123";
const DAY = 86_400_000;
let server: http.Server;
let base = "";

type Res = { status: number; body: any; headers: Headers };

class Agent {
	cookie = "";
	constructor(private origin = config.consoleOrigin) {}
	async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
		const res = await fetch(base + path, {
			method,
			headers: {
				...(body !== undefined ? { "content-type": "application/json" } : {}),
				...(this.cookie ? { cookie: this.cookie } : {}),
				origin: this.origin,
				...headers,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const set = res.headers.get("set-cookie");
		if (set) {
			const pair = set.split(";")[0];
			this.cookie = pair.endsWith("=") ? "" : pair;
		}
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
	}
	get = (p: string) => this.req("GET", p);
	post = (p: string, b: unknown = {}) => this.req("POST", p, b);
	put = (p: string, b: unknown) => this.req("PUT", p, b);
	patch = (p: string, b: unknown) => this.req("PATCH", p, b);
	del = (p: string, b: unknown = {}) => this.req("DELETE", p, b);
}

async function signIn(email: string, password = PASSWORD) {
	const a = new Agent();
	const r = await a.post("/v1/admin/auth/login", { email, password });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return a;
}

const state = async (a: Agent) => (await a.get("/v1/admin/state")).body;
const client = async (a: Agent, id: string) => (await state(a)).clients.find((c: any) => c.id === id);

async function setSettings(a: Agent, patch: (s: any) => void) {
	const s = (await state(a)).settings;
	patch(s);
	const r = await a.put("/v1/admin/settings", s);
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return r;
}

async function serviceKey(a: Agent, productId = "prd_rentbuddyz") {
	const r = await a.post(`/v1/admin/products/${productId}/service-key`);
	assert.equal(r.status, 200);
	return r.body.key as string;
}

const newClient = (overrides: Record<string, unknown> = {}) => ({
	name: "Test Rentals",
	slug: `test-${Math.random().toString(36).slice(2, 8)}`,
	productId: "prd_rentbuddyz",
	planId: "pl_rb_starter",
	billingCycle: "monthly",
	trialDays: 0,
	contact: { name: "Owner", email: "owner@test.example", phone: "" },
	company: { legalName: "", country: "US", timezone: "UTC", currency: "USD" },
	notes: "",
	...overrides,
});

before(async () => {
	server = createApp().listen(0);
	await new Promise((r) => server.once("listening", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
	server.close();
	await prisma.$disconnect();
});

beforeEach(async () => {
	await seedDemo(prisma, { wipe: true, password: PASSWORD });
	invalidateSettingsCache();
	resetRateLimits();
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe("auth", () => {
	it("signs in, returns state, signs out", async () => {
		const a = await signIn("admin@platform.demo");
		const s = await state(a);
		assert.equal(s.me.email, "admin@platform.demo");
		assert.equal(s.clients.length, 5);
		assert.ok(s.staff.every((m: any) => !("passwordHash" in m) && !("mfaSecret" in m)));
		assert.equal((await a.post("/v1/admin/auth/logout")).status, 200);
		assert.equal((await a.get("/v1/admin/state")).status, 401);
	});

	it("rejects a wrong password without revealing whether the email exists", async () => {
		const a = new Agent();
		const wrong = await a.post("/v1/admin/auth/login", { email: "admin@platform.demo", password: "nope" });
		const unknown = await a.post("/v1/admin/auth/login", { email: "ghost@platform.demo", password: "nope" });
		assert.equal(wrong.status, 401);
		assert.equal(unknown.status, 401);
		assert.equal(wrong.body.error.message, unknown.body.error.message);
	});

	it("rate-limits repeated failures", async () => {
		const a = new Agent();
		let last: Res | undefined;
		for (let i = 0; i < 11; i += 1) last = await a.post("/v1/admin/auth/login", { email: "admin@platform.demo", password: "bad" });
		assert.equal(last!.status, 429);
	});

	it("blocks requests from another origin", async () => {
		const a = await signIn("admin@platform.demo");
		const evil = new Agent("https://evil.example");
		evil.cookie = a.cookie;
		const r = await evil.post("/v1/admin/leads", {});
		assert.equal(r.status, 403);
		assert.equal(r.body.error.code, "bad_origin");
	});

	it("with TWO_FACTOR off: no codes, no forced setup, 2FA routes gone", async () => {
		const owner = await signIn("admin@platform.demo");
		await setSettings(owner, (s) => (s.security.enforce2fa = true));
		// Even an account that enrolled earlier signs in with just its password.
		await prisma.staff.update({ where: { id: "st_support" }, data: { mfaEnabled: true, mfaSecret: otplib.authenticator.generateSecret() } });
		const support = new Agent();
		const login = await support.post("/v1/admin/auth/login", { email: "support@platform.demo", password: PASSWORD });
		assert.equal(login.body.mfaRequired, false);
		assert.equal(login.body.me.mfaSetupRequired, false);
		assert.equal((await support.get("/v1/admin/state")).status, 200);
		assert.equal((await support.get("/v1/admin/state")).body.capabilities.twoFactor, false);
		assert.equal((await support.post("/v1/admin/auth/mfa/setup")).status, 404);
		assert.equal((await owner.post("/v1/admin/staff/st_support/reset-mfa")).status, 404);
	});

	it("enrols TOTP, then requires the code at sign-in (TWO_FACTOR=on)", async (t) => {
		config.twoFactor = true;
		t.after(() => {
			config.twoFactor = false;
		});
		const a = await signIn("admin@platform.demo");
		const setup = await a.post("/v1/admin/auth/mfa/setup");
		assert.equal(setup.status, 200);
		assert.match(setup.body.qrDataUrl, /^data:image\/png;base64,/);
		assert.equal((await a.post("/v1/admin/auth/mfa/enable", { code: "000000" })).status, 400);
		const enabled = await a.post("/v1/admin/auth/mfa/enable", { code: otplib.authenticator.generate(setup.body.secret) });
		assert.equal(enabled.status, 200);
		assert.equal(enabled.body.me.twoFactor, true);

		const b = new Agent();
		const login = await b.post("/v1/admin/auth/login", { email: "admin@platform.demo", password: PASSWORD });
		assert.deepEqual(login.body, { mfaRequired: true });
		assert.equal((await b.get("/v1/admin/state")).status, 401);
		assert.equal((await b.post("/v1/admin/auth/mfa/verify", { code: "123456" })).status, 401);
		const ok = await b.post("/v1/admin/auth/mfa/verify", { code: otplib.authenticator.generate(setup.body.secret) });
		assert.equal(ok.status, 200);
		assert.equal((await b.get("/v1/admin/state")).status, 200);
	});

	it("forces 2FA enrolment when the platform requires it (TWO_FACTOR=on)", async (t) => {
		config.twoFactor = true;
		t.after(() => {
			config.twoFactor = false;
		});
		const owner = await signIn("admin@platform.demo");
		await setSettings(owner, (s) => (s.security.enforce2fa = true));
		const support = await signIn("support@platform.demo");
		const me = await support.get("/v1/admin/auth/me");
		assert.equal(me.body.me.mfaSetupRequired, true);
		const blocked = await support.get("/v1/admin/state");
		assert.equal(blocked.status, 403);
		assert.equal(blocked.body.error.code, "mfa_setup_required");
	});

	it("invites a member who sets a password from the link", async () => {
		const owner = await signIn("admin@platform.demo");
		const inv = await owner.post("/v1/admin/staff/invite", { name: "New Person", email: "new@platform.demo", role: "support" });
		assert.equal(inv.status, 201);
		const token = new URL(inv.body.link).searchParams.get("token")!;
		assert.equal((await new Agent().get(`/v1/admin/auth/token/${token}`)).body.email, "new@platform.demo");
		assert.equal((await new Agent().post("/v1/admin/auth/token/accept", { token, password: "short" })).status, 400);
		assert.equal((await new Agent().post("/v1/admin/auth/token/accept", { token, password: "a-long-password" })).status, 200);
		assert.equal((await new Agent().post("/v1/admin/auth/token/accept", { token, password: "a-long-password" })).status, 410);
		await signIn("new@platform.demo", "a-long-password");
		const email = await prisma.emailOutbox.findFirst({ where: { to: "new@platform.demo" } });
		assert.ok(email?.text.includes("/accept-invite?token="));
	});

	it("enforces the IP allow-list and refuses one that would lock you out", async () => {
		const owner = await signIn("admin@platform.demo");
		const s = (await state(owner)).settings;
		s.security.ipAllowlist = "203.0.113.0/24";
		const r = await owner.put("/v1/admin/settings", s);
		assert.equal(r.status, 400);
		assert.equal(r.body.error.code, "allowlist_lockout");
		s.security.ipAllowlist = "127.0.0.1\n::1\nnot-an-ip";
		assert.equal((await owner.put("/v1/admin/settings", s)).body.error.code, "invalid_allowlist");
		s.security.ipAllowlist = "127.0.0.1\n::1";
		assert.equal((await owner.put("/v1/admin/settings", s)).status, 200);
		assert.equal((await owner.get("/v1/admin/state")).status, 200);
	});
});

describe("permissions", () => {
	it("enforces roles server-side", async () => {
		const support = await signIn("support@platform.demo");
		const s = await state(support);
		assert.equal((await support.post("/v1/admin/plans", { ...s.plans[0], code: "x-new" })).status, 403);
		assert.equal((await support.post("/v1/admin/clients", newClient())).status, 403);
		assert.equal((await support.put("/v1/admin/settings", s.settings)).status, 403);
		const billing = await signIn("billing@platform.demo");
		assert.equal((await billing.post(`/v1/admin/clients/cl_ao/status`, { status: "suspended", reason: "Testing" })).status, 200);
		assert.equal((await billing.post(`/v1/admin/clients/cl_ao/impersonate`, { reason: "Testing" })).status, 403);
	});

	it("never lets the last owner be demoted or disabled", async () => {
		const owner = await signIn("admin@platform.demo");
		assert.equal((await owner.patch("/v1/admin/staff/st_owner", { role: "admin" })).status, 403);
		await owner.patch("/v1/admin/staff/st_sales", { role: "owner" });
		const sales = await signIn("sales@platform.demo");
		assert.equal((await sales.patch("/v1/admin/staff/st_owner", { status: "disabled" })).status, 200);
		const s = await state(sales);
		assert.equal(s.staff.find((m: any) => m.id === "st_owner").status, "disabled");
		// A disabled member can't sign in, and their sessions are gone.
		const r = await new Agent().post("/v1/admin/auth/login", { email: "admin@platform.demo", password: PASSWORD });
		assert.equal(r.body.error.code, "account_inactive");
		assert.equal((await owner.get("/v1/admin/state")).status, 401);
	});
});

describe("clients", () => {
	it("creates a paid client with its first invoice and audit entry", async () => {
		const a = await signIn("admin@platform.demo");
		const r = await a.post("/v1/admin/clients", newClient({ slug: "fresh-co" }));
		assert.equal(r.status, 201, JSON.stringify(r.body));
		assert.equal(r.body.client.status, "active");
		assert.equal(r.body.client.adminHost, "fresh-co-admin.unlockvelocity.in");
		assert.equal(r.body.client.storefronts[0].verified, true);
		assert.equal(r.body.invoice.subtotal, 49);
		assert.equal(r.body.invoice.tax, 3.92);
		assert.equal(r.body.invoice.total, 52.92);
		assert.equal(r.body.invoice.number, "INV-1054");
		const audit = await prisma.auditEntry.findFirst({ where: { entityId: r.body.client.id, action: "client.created" } });
		assert.equal(audit?.actorName, "Admin");
	});

	it("validates slugs and hosts", async () => {
		const a = await signIn("admin@platform.demo");
		assert.equal((await a.post("/v1/admin/clients", newClient({ slug: "nca" }))).body.error.code, "slug_taken");
		assert.equal((await a.post("/v1/admin/clients", newClient({ slug: "admin" }))).body.error.code, "slug_reserved");
		assert.equal((await a.post("/v1/admin/clients", newClient({ slug: "Bad Slug" }))).status, 400);
		assert.equal((await a.post("/v1/admin/clients", newClient({ planId: "pl_pos_counter" }))).status, 400);
	});

	it("starts a trial without an invoice, converts it with one", async () => {
		const a = await signIn("admin@platform.demo");
		const r = await a.post("/v1/admin/clients", newClient({ trialDays: 14 }));
		assert.equal(r.body.client.status, "trial");
		assert.equal(r.body.invoice, null);
		const conv = await a.post(`/v1/admin/clients/${r.body.client.id}/status`, { status: "active" });
		assert.equal(conv.status, 200);
		assert.equal(conv.body.client.status, "active");
		assert.equal(conv.body.client.trialEndsAt, undefined);
		assert.equal(conv.body.invoice.subtotal, 49);
	});

	it("converts a lead and marks it won", async () => {
		const a = await signIn("admin@platform.demo");
		const r = await a.post("/v1/admin/clients", newClient({ leadId: "ld_1" }));
		const lead = (await state(a)).leads.find((l: any) => l.id === "ld_1");
		assert.equal(lead.status, "won");
		assert.equal(lead.clientId, r.body.client.id);
		assert.equal((await a.post("/v1/admin/clients", newClient({ leadId: "ld_1" }))).status, 409);
	});

	it("applies feature overrides, rejects core and unknown keys, and shows them in entitlements", async () => {
		const a = await signIn("admin@platform.demo");
		assert.equal((await a.patch("/v1/admin/clients/cl_cityline", { featureOverrides: { orders: false } })).status, 400);
		assert.equal((await a.patch("/v1/admin/clients/cl_cityline", { featureOverrides: { nope: true } })).status, 400);
		const r = await a.patch("/v1/admin/clients/cl_cityline", { featureOverrides: { pos: true, rentals: false } });
		assert.equal(r.status, 200);
		const key = await serviceKey(a);
		const ent = await new Agent().req("GET", "/v1/integration/tenants/cityline/entitlements", undefined, { authorization: `Bearer ${key}` });
		assert.equal(ent.status, 200);
		assert.ok(ent.body.features.includes("pos"));
		assert.ok(!ent.body.features.includes("rentals"));
		assert.ok(ent.body.features.includes("orders"));
		const audit = await prisma.auditEntry.findFirst({ where: { entityId: "cl_cityline", action: "client.feature_override" } });
		assert.match(audit!.summary, /Turned on In-store POS/);
		assert.match(audit!.summary, /Turned off Rental management/);
	});

	it("manages storefront domains without trusting client-sent verification", async () => {
		const a = await signIn("admin@platform.demo");
		const c = await client(a, "cl_cityline");
		// Starter has no custom domains.
		const denied = await a.patch("/v1/admin/clients/cl_cityline", { storefronts: [...c.storefronts, { host: "shop.cityline.example", verified: true, primary: false, sslStatus: "active" }] });
		assert.equal(denied.body.error.code, "feature_not_in_plan");
		await a.patch("/v1/admin/clients/cl_cityline", { featureOverrides: { custom_domain: true } });
		const added = await a.patch("/v1/admin/clients/cl_cityline", { storefronts: [...c.storefronts, { host: "shop.cityline.example", verified: true, primary: false, sslStatus: "active" }] });
		const custom = added.body.client.storefronts.find((s: any) => s.host === "shop.cityline.example");
		assert.equal(custom.verified, false);
		assert.equal(custom.sslStatus, "pending");
		// Can't be primary until verified.
		const prim = await a.patch("/v1/admin/clients/cl_cityline", { storefronts: added.body.client.storefronts.map((s: any) => ({ ...s, primary: s.host === "shop.cityline.example" })) });
		assert.equal(prim.status, 400);
		const dns = await a.post("/v1/admin/clients/cl_cityline/domains/verify", { host: "shop.cityline.example" });
		assert.equal(dns.status, 409);
		assert.equal(dns.body.error.code, "dns_not_ready");
		const manual = await a.post("/v1/admin/clients/cl_cityline/domains/verify", { host: "shop.cityline.example", manual: true });
		assert.equal(manual.body.client.storefronts.find((s: any) => s.host === "shop.cityline.example").verified, true);
		// A host can only belong to one client.
		const ao = await client(a, "cl_ao");
		const clash = await a.patch("/v1/admin/clients/cl_ao", { storefronts: [...ao.storefronts, { host: "shop.cityline.example", verified: false, primary: false, sslStatus: "pending" }] });
		assert.equal(clash.status, 409);
	});

	it("upgrades immediately with a prorated invoice and schedules downgrades for renewal", async () => {
		const a = await signIn("admin@platform.demo");
		const up = await a.post("/v1/admin/clients/cl_ao/plan", { planId: "pl_rb_pro", billingCycle: "monthly" });
		assert.equal(up.status, 200, JSON.stringify(up.body));
		assert.equal(up.body.effect, "applied");
		assert.equal(up.body.client.planId, "pl_rb_pro");
		assert.ok(up.body.invoice.subtotal > 0 && up.body.invoice.subtotal < 150, `prorated ${up.body.invoice.subtotal}`);

		const down = await a.post("/v1/admin/clients/cl_ao/plan", { planId: "pl_rb_starter", billingCycle: "monthly" });
		assert.equal(down.body.effect, "scheduled");
		assert.equal(down.body.client.planId, "pl_rb_pro");
		assert.equal(down.body.client.pendingPlanId, "pl_rb_starter");
		assert.equal(down.body.invoice, null);

		// Renewal applies the scheduled change and bills the new price (once the upgrade invoice is paid).
		assert.equal((await a.post(`/v1/admin/invoices/${up.body.invoice.id}/status`, { status: "paid" })).status, 200);
		const end = new Date(down.body.client.currentPeriodEnd);
		await runLifecycle(new Date(end.getTime() + 1000));
		const after = await client(a, "cl_ao");
		assert.equal(after.planId, "pl_rb_starter");
		assert.equal(after.pendingPlanId, undefined);
		const renewal = (await state(a)).invoices.find((i: any) => i.clientId === "cl_ao" && i.subtotal === 49);
		assert.ok(renewal, "renewal invoice at Starter price");

		const cancel = await a.del("/v1/admin/clients/cl_ao/pending-change");
		assert.equal(cancel.status, 400);
	});

	it("suspends with a reason and reactivates", async () => {
		const a = await signIn("admin@platform.demo");
		assert.equal((await a.post("/v1/admin/clients/cl_ao/status", { status: "suspended" })).body.error.code, "reason_required");
		const s = await a.post("/v1/admin/clients/cl_ao/status", { status: "suspended", reason: "Abuse report" });
		assert.equal(s.body.client.status, "suspended");
		assert.equal(s.body.client.suspendedReason, "Abuse report");
		const key = await serviceKey(a);
		const ent = await new Agent().req("GET", "/v1/integration/tenants/ao/entitlements", undefined, { authorization: `Bearer ${key}` });
		assert.equal(ent.body.readOnly, true);
		const r = await a.post("/v1/admin/clients/cl_ao/status", { status: "active" });
		assert.equal(r.body.client.status, "active");
		assert.equal(r.body.client.suspendedReason, undefined);
	});

	it("deletes only with the slug typed, keeping invoices", async () => {
		const a = await signIn("admin@platform.demo");
		assert.equal((await a.del("/v1/admin/clients/cl_ao", { confirmSlug: "nope" })).status, 400);
		assert.equal((await a.del("/v1/admin/clients/cl_ao", { confirmSlug: "ao" })).status, 200);
		const s = await state(a);
		assert.ok(!s.clients.some((c: any) => c.id === "cl_ao"));
		assert.ok(s.invoices.some((i: any) => i.clientId === "cl_ao"));
	});

	it("runs real health checks against the configured URL", async () => {
		const target = http.createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/ok") res.end(JSON.stringify({ status: "ok", version: "9.9.9" }));
			else {
				res.statusCode = 503;
				res.end("{}");
			}
		});
		target.listen(0);
		await new Promise((r) => target.once("listening", r));
		const port = (target.address() as AddressInfo).port;
		try {
			const a = await signIn("admin@platform.demo");
			await a.patch("/v1/admin/clients/cl_ao", { healthUrl: `http://127.0.0.1:${port}/ok` });
			await a.patch("/v1/admin/clients/cl_nca", { healthUrl: `http://127.0.0.1:${port}/bad` });
			await a.patch("/v1/admin/clients/cl_sunrise", { healthUrl: "http://127.0.0.1:1/health" });
			const r = await a.post("/v1/admin/clients/health-check", { ids: ["cl_ao", "cl_nca", "cl_sunrise"] });
			const by = Object.fromEntries(r.body.clients.map((c: any) => [c.id, c.health]));
			assert.equal(by.cl_ao.state, "up");
			assert.equal(by.cl_ao.version, "9.9.9");
			assert.equal(by.cl_nca.state, "down");
			assert.equal(by.cl_nca.error, "HTTP 503");
			assert.equal(by.cl_sunrise.state, "down"); // nothing listening
		} finally {
			target.close();
		}
	});
});

describe("billing lifecycle", () => {
	it("walks an unpaid invoice through overdue → past due → suspended → cancelled, and payment restores", async () => {
		const a = await signIn("admin@platform.demo");
		const created = await a.post("/v1/admin/clients", newClient({ slug: "late-payer" }));
		const id = created.body.client.id;
		const due = new Date(created.body.invoice.dueAt).getTime();

		await runLifecycle(new Date(due + DAY));
		let c = await client(a, id);
		assert.equal(c.status, "past_due");
		assert.equal((await state(a)).invoices.find((i: any) => i.id === created.body.invoice.id).status, "overdue");

		await runLifecycle(new Date(due + 15 * DAY));
		c = await client(a, id);
		assert.equal(c.status, "suspended");
		assert.equal(c.suspendedReason, "Unpaid invoices");

		const paid = await a.post(`/v1/admin/invoices/${created.body.invoice.id}/status`, { status: "paid" });
		assert.equal(paid.status, 200);
		assert.equal(paid.body.client.status, "active");

		// A second unpaid period goes all the way to cancelled.
		const inv2 = await a.post(`/v1/admin/clients/${id}/invoices`);
		const due2 = new Date(inv2.body.invoice.dueAt).getTime();
		await runLifecycle(new Date(due2 + DAY));
		await runLifecycle(new Date(due2 + 46 * DAY));
		c = await client(a, id);
		assert.equal(c.status, "cancelled");
		const dunningEmails = await prisma.emailOutbox.count({ where: { to: "owner@test.example" } });
		assert.ok(dunningEmails >= 3);
	});

	it("suspends trials that end without converting", async () => {
		const a = await signIn("admin@platform.demo");
		const c = await client(a, "cl_cityline");
		await runLifecycle(new Date(new Date(c.trialEndsAt).getTime() + 1000));
		const after = await client(a, "cl_cityline");
		assert.equal(after.status, "suspended");
		assert.equal(after.suspendedReason, "Trial ended");
	});

	it("does nothing on a second run", async () => {
		const a = await signIn("admin@platform.demo");
		const later = new Date(Date.now() + 40 * DAY);
		await runLifecycle(later);
		const count = await prisma.invoice.count();
		const report = await runLifecycle(later);
		assert.equal(await prisma.invoice.count(), count);
		assert.deepEqual(report, { overdueInvoices: 0, pastDue: 0, suspended: 0, cancelled: 0, trialsEnded: 0, renewed: 0 });
		assert.ok(a);
	});

	it("refuses to pay an invoice twice", async () => {
		const a = await signIn("billing@platform.demo");
		const open = (await state(a)).invoices.find((i: any) => i.status === "overdue");
		assert.equal((await a.post(`/v1/admin/invoices/${open.id}/status`, { status: "paid" })).status, 200);
		assert.equal((await a.post(`/v1/admin/invoices/${open.id}/status`, { status: "paid" })).status, 400);
	});
});

describe("plans and products", () => {
	it("creates, edits, archives plans with validation", async () => {
		const a = await signIn("admin@platform.demo");
		const body = {
			productId: "prd_rentbuddyz",
			name: "Seasonal",
			code: "rb-seasonal",
			description: "",
			currency: "USD",
			priceMonthly: 79.5,
			priceYearly: 795,
			trialDays: 7,
			limits: { stores: 2, staffUsers: 10, products: 1000, ordersPerMonth: -1, storageGb: 10 },
			features: ["rentals"],
			isPublic: true,
			highlighted: true,
			sortOrder: 5,
		};
		const r = await a.post("/v1/admin/plans", body);
		assert.equal(r.status, 201);
		assert.equal(r.body.plan.priceMonthly, 79.5);
		assert.ok(r.body.plan.features.includes("orders"), "core features are always included");
		const s = await state(a);
		assert.equal(s.plans.filter((p: any) => p.productId === "prd_rentbuddyz" && p.highlighted).length, 1);
		assert.equal((await a.post("/v1/admin/plans", body)).body.error.code, "code_taken");
		assert.equal((await a.post("/v1/admin/plans", { ...body, code: "rb-x", features: ["made_up"] })).status, 400);
		assert.equal((await a.post(`/v1/admin/plans/${r.body.plan.id}/status`, { status: "archived" })).body.plan.status, "archived");
		// Archived plans can't be chosen for new clients.
		assert.equal((await a.post("/v1/admin/clients", newClient({ planId: r.body.plan.id }))).status, 400);
	});

	it("protects features that plans still use", async () => {
		const a = await signIn("admin@platform.demo");
		const p = (await state(a)).products.find((x: any) => x.id === "prd_rentbuddyz");
		const r = await a.put("/v1/admin/products/prd_rentbuddyz", { ...p, features: p.features.filter((f: any) => f.key !== "rentals") });
		assert.equal(r.status, 409);
		assert.equal(r.body.error.code, "feature_in_use");
	});
});

describe("product integration", () => {
	it("authenticates products and scopes them to their own tenants", async () => {
		const a = await signIn("admin@platform.demo");
		assert.equal((await new Agent().get("/v1/integration/tenants/ao/entitlements")).status, 401);
		const pos = await serviceKey(a, "prd_pos");
		assert.equal((await new Agent().req("GET", "/v1/integration/tenants/ao/entitlements", undefined, { authorization: `Bearer ${pos}` })).status, 404);
		const rb = await serviceKey(a);
		const byHost = await new Agent().req("GET", "/v1/integration/hosts/demo-ao.unlockvelocity.in/entitlements", undefined, { authorization: `Bearer ${rb}` });
		assert.equal(byHost.body.tenant, "ao");
		// Rotating invalidates the old key.
		await serviceKey(a);
		assert.equal((await new Agent().req("GET", "/v1/integration/tenants/ao/entitlements", undefined, { authorization: `Bearer ${rb}` })).status, 401);
	});

	it("accepts usage reports", async () => {
		const a = await signIn("admin@platform.demo");
		const key = await serviceKey(a);
		const usage = { stores: 2, staffUsers: 9, products: 900, ordersPerMonth: 120, storageGb: 3.5 };
		const r = await new Agent().req("POST", "/v1/integration/tenants/ao/usage", usage, { authorization: `Bearer ${key}` });
		assert.equal(r.status, 200);
		const c = await client(a, "cl_ao");
		assert.deepEqual(c.usage, usage);
		assert.ok(c.usageReportedAt);
	});

	it("issues single-use impersonation tokens", async () => {
		const a = await signIn("support@platform.demo");
		assert.equal((await a.post("/v1/admin/clients/cl_ao/impersonate", { reason: "" })).body.error.code, "reason_required");
		const r = await a.post("/v1/admin/clients/cl_ao/impersonate", { reason: "Ticket #311" });
		assert.equal(r.status, 200);
		assert.match(r.body.url, /^https:\/\/demo-ao\.unlockvelocity\.in\/impersonate\?token=/);
		const token = new URL(r.body.url).searchParams.get("token");
		const owner = await signIn("admin@platform.demo");
		const key = await serviceKey(owner);
		const ex = await new Agent().req("POST", "/v1/integration/impersonate/exchange", { token }, { authorization: `Bearer ${key}` });
		assert.equal(ex.status, 200);
		assert.equal(ex.body.tenant, "ao");
		assert.equal(ex.body.staff.name, "Support team");
		assert.equal(ex.body.reason, "Ticket #311");
		const again = await new Agent().req("POST", "/v1/integration/impersonate/exchange", { token }, { authorization: `Bearer ${key}` });
		assert.equal(again.status, 410);
	});

	it("round-trips a support ticket between product and console", async () => {
		const a = await signIn("admin@platform.demo");
		const key = await serviceKey(a);
		const auth = { authorization: `Bearer ${key}` };
		const created = await new Agent().req("POST", "/v1/integration/tenants/nca/tickets", { subject: "Printer", body: "Slips print blank", author: "NCA manager" }, auth);
		assert.equal(created.status, 201);
		assert.equal(created.body.ticket.number, 313);
		const reply = await a.patch(`/v1/admin/tickets/${created.body.ticket.id}`, { reply: "Try the updated driver", status: "pending" });
		assert.equal(reply.body.ticket.messages.length, 2);
		assert.equal(reply.body.ticket.status, "pending");
		const back = await new Agent().req("POST", `/v1/integration/tenants/nca/tickets/313/messages`, { body: "Still blank", author: "NCA manager" }, auth);
		assert.equal(back.body.ticket.status, "open");
		const other = await new Agent().req("POST", `/v1/integration/tenants/ao/tickets/313/messages`, { body: "x", author: "x" }, auth);
		assert.equal(other.status, 404);
	});

	it("delivers signed webhooks", async () => {
		const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
		const hook = http.createServer((req, res) => {
			let body = "";
			req.on("data", (d) => (body += d)).on("end", () => {
				received.push({ headers: req.headers, body });
				res.end("ok");
			});
		});
		hook.listen(0);
		await new Promise((r) => hook.once("listening", r));
		try {
			const a = await signIn("admin@platform.demo");
			await setSettings(a, (s) => (s.webhookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`));
			await a.post("/v1/admin/clients/cl_ao/status", { status: "suspended", reason: "Webhook test" });
			await deliverWebhooks();
			const evt = received.find((r) => r.headers["x-platform-event"] === "client.status_changed");
			assert.ok(evt, "event delivered");
			const [t, v1] = String(evt!.headers["x-platform-signature"]).split(",").map((p) => p.split("=")[1]);
			assert.equal(v1, createHmac("sha256", config.webhookSecret).update(`${t}.${evt!.body}`).digest("hex"));
			assert.equal(JSON.parse(evt!.body).data.status, "suspended");
		} finally {
			hook.close();
		}
	});
});

describe("public endpoints", () => {
	it("serves pricing and accepts leads (deduped, honeypot, closed form)", async () => {
		const p = await new Agent().get("/v1/public/pricing?product=rentbuddyz");
		assert.equal(p.status, 200);
		assert.deepEqual(
			p.body.products[0].plans.map((x: any) => x.code),
			["rb-starter", "rb-standard", "rb-pro"],
		);
		const lead = { name: "Web Visitor", email: "visitor@site.example", message: "Hi" };
		assert.equal((await new Agent().post("/v1/public/leads", lead)).status, 202);
		assert.equal((await new Agent().post("/v1/public/leads", { ...lead, message: "Again" })).status, 202);
		assert.equal(await prisma.lead.count({ where: { email: "visitor@site.example" } }), 1);
		assert.equal((await new Agent().post("/v1/public/leads", { ...lead, email: "bot@x.example", website: "spam" })).status, 202);
		assert.equal(await prisma.lead.count({ where: { email: "bot@x.example" } }), 0);
		const a = await signIn("admin@platform.demo");
		const w = (await state(a)).website;
		await a.put("/v1/admin/website", { ...w, leadFormEnabled: false });
		assert.equal((await new Agent().post("/v1/public/leads", { ...lead, email: "late@site.example" })).status, 403);
	});
});

describe("leads", () => {
	it("requires a reason to mark lost and blocks manual won", async () => {
		const a = await signIn("sales@platform.demo");
		const l = (await state(a)).leads.find((x: any) => x.id === "ld_2");
		assert.equal((await a.put("/v1/admin/leads/ld_2", { ...l, status: "lost" })).body.error.code, "reason_required");
		assert.equal((await a.put("/v1/admin/leads/ld_2", { ...l, status: "won" })).status, 400);
		const r = await a.put("/v1/admin/leads/ld_2", { ...l, status: "lost", lostReason: "Went with a competitor" });
		assert.equal(r.body.lead.status, "lost");
	});
});
