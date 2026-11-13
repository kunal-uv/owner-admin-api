import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { prisma } from "../src/db.js";
import { invalidateSettingsCache, resetRateLimits } from "../src/lib/auth.js";
import { runLifecycle } from "../src/lib/lifecycle.js";
import { seedDemo } from "./fixtures/seed-data.js";

const PASSWORD = "test-password-123";
let server: http.Server;
let base = "";
let cookie = "";

const call = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(base + path, {
		method,
		headers: { "content-type": "application/json", origin: config.consoleOrigin, ...(cookie ? { cookie } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const set = res.headers.get("set-cookie");
	if (set) cookie = set.split(";")[0];
	return { status: res.status, body: await res.json() };
};

before(async () => {
	await seedDemo(prisma, { wipe: true, password: PASSWORD });
	invalidateSettingsCache();
	resetRateLimits();
	server = createApp().listen(0);
	await new Promise((r) => server.once("listening", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	assert.equal((await call("POST", "/v1/admin/auth/login", { email: "admin@platform.demo", password: PASSWORD })).status, 200);
});

after(async () => {
	server.close();
	await prisma.$disconnect();
});

describe("free plans", () => {
	it("never issue invoices — not at creation, conversion or renewal", async () => {
		const plan = await call("POST", "/v1/admin/plans", {
			productId: "prd_rentbuddyz",
			name: "Internal",
			code: "rb-internal",
			description: "",
			currency: "USD",
			priceMonthly: 0,
			priceYearly: 0,
			trialDays: 0,
			limits: { stores: -1, staffUsers: -1, products: -1, ordersPerMonth: -1, storageGb: -1 },
			features: [],
			isPublic: false,
			sortOrder: 9,
		});
		assert.equal(plan.status, 201, JSON.stringify(plan.body));
		const created = await call("POST", "/v1/admin/clients", {
			name: "Free Co",
			slug: "free-co",
			productId: "prd_rentbuddyz",
			planId: plan.body.plan.id,
			billingCycle: "monthly",
			trialDays: 0,
			contact: { name: "Owner", email: "owner@free.example", phone: "" },
			company: { legalName: "", country: "US", timezone: "UTC", currency: "USD" },
			notes: "",
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.equal(created.body.client.status, "active");
		assert.equal(created.body.invoice, null);

		const manual = await call("POST", `/v1/admin/clients/${created.body.client.id}/invoices`);
		assert.equal(manual.body.error.code, "free_plan");

		await runLifecycle(new Date(new Date(created.body.client.currentPeriodEnd).getTime() + 1000));
		assert.equal(await prisma.invoice.count({ where: { clientId: created.body.client.id } }), 0);
		const after = await prisma.client.findUniqueOrThrow({ where: { id: created.body.client.id } });
		assert.equal(after.status, "active");
		assert.ok(after.currentPeriodEnd > new Date(created.body.client.currentPeriodEnd), "period still rolls forward");
	});
});
