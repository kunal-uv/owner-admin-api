import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { prisma } from "../src/db.js";
import { invalidateSettingsCache, resetRateLimits } from "../src/lib/auth.js";
import { ensurePlatform } from "../src/lib/bootstrap.js";
import { seedDemo, wipe } from "./fixtures/seed-data.js";

/*
 * Client websites: the console manages each client's website content in the
 * client's own RentBuddyz backend. A fake backend here implements the same
 * /api/platform/site and /api/site-content contract as rent-buddyz-backend.
 */

const PASSWORD = "test-password-123";
const KEY = "k".repeat(40);
let server: http.Server;
let base = "";
let fake: http.Server;
let fakeUrl = "";
const seen: { method: string; url: string; key?: string; body: string; type?: string }[] = [];
let draft: Record<string, unknown> = { version: 1, pages: {}, custom_pages: [] };

class Agent {
	cookie = "";
	async req(method: string, path: string, body?: unknown) {
		const res = await fetch(base + path, {
			method,
			headers: {
				...(body !== undefined ? { "content-type": "application/json" } : {}),
				...(this.cookie ? { cookie: this.cookie } : {}),
				origin: config.consoleOrigin,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const set = res.headers.get("set-cookie");
		if (set) this.cookie = set.split(";")[0];
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	}
	get = (p: string) => this.req("GET", p);
	post = (p: string, b: unknown = {}) => this.req("POST", p, b);
	put = (p: string, b: unknown) => this.req("PUT", p, b);
	patch = (p: string, b: unknown) => this.req("PATCH", p, b);
}

async function signIn(email: string) {
	const a = new Agent();
	const r = await a.post("/v1/admin/auth/login", { email, password: PASSWORD });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return a;
}

before(async () => {
	server = createApp().listen(0);
	await new Promise((r) => server.once("listening", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	fake = http.createServer((req, res) => {
		let body = "";
		req.setEncoding("latin1");
		req.on("data", (d) => (body += d)).on("end", () => {
			seen.push({ method: req.method!, url: req.url!, key: req.headers["x-platform-key"] as string | undefined, body, type: req.headers["content-type"] });
			const send = (status: number, payload: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			if (req.url === "/health") return send(200, { uptime: 1 });
			if (req.url === "/api/site-content") {
				return send(200, { code: 200, success: true, data: { version: 1, pages: { home: { seo: null, order: ["hero"], sections: { hero: { hidden: false, values: { title: "Rent anything" } } } } }, custom_pages: [] } });
			}
			if (!req.url!.startsWith("/api/platform/")) return send(404, { message: "not found" });
			if (req.headers["x-platform-key"] !== KEY) return send(401, { message: "Invalid platform key" });
			const state = () => ({ draft, published: {}, has_unpublished_changes: true, draft_updated_at: null, published_at: null });
			if (req.method === "GET" && req.url === "/api/platform/site") {
				return send(200, { code: 200, success: true, data: { schema: { pages: [{ key: "home", label: "Home", group: "Shop", path: "/", sections: [] }], icons: [], fonts: [] }, ...state() } });
			}
			if (req.method === "PUT" && req.url === "/api/platform/site/draft") {
				const parsed = JSON.parse(body);
				if (parsed.content.pages?.bad) return send(400, { message: "Unknown page bad" });
				draft = parsed.content;
				return send(200, { code: 200, success: true, data: state() });
			}
			if (req.method === "POST" && req.url === "/api/platform/site/publish") return send(200, { code: 200, success: true, data: { ...state(), has_unpublished_changes: false } });
			if (req.method === "POST" && req.url === "/api/platform/site/discard") return send(200, { code: 200, success: true, data: state() });
			if (req.method === "POST" && req.url === "/api/platform/site/preview-token") return send(200, { code: 200, success: true, data: { token: "preview-123", expires_in: 900 } });
			if (req.method === "POST" && req.url === "/api/platform/site/upload") return send(200, { code: 200, success: true, data: { path: body.includes("PNGDATA") ? "uploads/x.png" : "missing" } });
			return send(404, { message: "not found" });
		});
	});
	fake.listen(0);
	await new Promise((r) => fake.once("listening", r));
	fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/api`;
});

after(async () => {
	fake.close();
	server.close();
	await prisma.$disconnect();
});

beforeEach(async () => {
	await seedDemo(prisma, { wipe: true, password: PASSWORD });
	invalidateSettingsCache();
	resetRateLimits();
	seen.length = 0;
});

describe("client product connection", () => {
	it("stores the API address and an encrypted platform key, never returning the key", async () => {
		const a = await signIn("admin@platform.demo");
		assert.equal((await a.patch("/v1/admin/clients/cl_ao", { apiBaseUrl: "not a url" })).status, 400);
		assert.equal((await a.patch("/v1/admin/clients/cl_ao", { apiBaseUrl: "ftp://x.example/api" })).status, 400);
		assert.equal((await a.patch("/v1/admin/clients/cl_ao", { platformKey: "short" })).status, 400);
		const r = await a.patch("/v1/admin/clients/cl_ao", { apiBaseUrl: `${fakeUrl}/`, platformKey: KEY });
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.client.apiBaseUrl, fakeUrl);
		assert.equal(r.body.client.platformKeyHint, "kkkk");
		const raw = JSON.stringify((await a.get("/v1/admin/state")).body);
		assert.ok(!raw.includes(KEY), "the key never leaves the API");
		const row = await prisma.client.findUnique({ where: { id: "cl_ao" } });
		assert.ok(row!.platformKeyEnc && !row!.platformKeyEnc.includes(KEY), "stored encrypted");
		const audit = await prisma.auditEntry.findFirst({ where: { entityId: "cl_ao", action: "client.connection" } });
		assert.match(audit!.summary, /Added a platform key/);
		assert.ok(!audit!.summary.includes(KEY));
		const cleared = await a.patch("/v1/admin/clients/cl_ao", { platformKey: "" });
		assert.equal(cleared.body.client.platformKeyHint, undefined);
	});

	it("accepts the connection when creating a client", async () => {
		const a = await signIn("admin@platform.demo");
		const r = await a.post("/v1/admin/clients", {
			name: "Connected Co",
			slug: "connected-co",
			productId: "prd_rentbuddyz",
			planId: "pl_rb_starter",
			billingCycle: "monthly",
			trialDays: 14,
			contact: { name: "Owner", email: "owner@connected.example", phone: "" },
			company: { legalName: "", country: "US", timezone: "UTC", currency: "USD" },
			notes: "",
			apiBaseUrl: fakeUrl,
			platformKey: KEY,
		});
		assert.equal(r.status, 201, JSON.stringify(r.body));
		assert.equal(r.body.client.platformKeyHint, "kkkk");
		assert.equal((await a.get(`/v1/admin/clients/${r.body.client.id}/site`)).body.mode, "managed");
	});
});

describe("client websites", () => {
	it("shows the published site without a key, and the full editor with one", async () => {
		const a = await signIn("admin@platform.demo");
		await a.patch("/v1/admin/clients/cl_ao", { apiBaseUrl: fakeUrl });
		const pub = await a.get("/v1/admin/clients/cl_ao/site");
		assert.equal(pub.status, 200, JSON.stringify(pub.body));
		assert.equal(pub.body.mode, "public");
		assert.equal(pub.body.published.pages.home.sections.hero.values.title, "Rent anything");
		assert.equal(pub.body.websiteUrl, "https://demo-ao-shop.unlockvelocity.in");
		assert.equal((await a.put("/v1/admin/clients/cl_ao/site/draft", { content: {} })).body.error.code, "no_platform_key");

		await a.patch("/v1/admin/clients/cl_ao", { platformKey: KEY });
		const managed = await a.get("/v1/admin/clients/cl_ao/site");
		assert.equal(managed.body.mode, "managed");
		assert.equal(managed.body.site.schema.pages[0].label, "Home");
		const content = { version: 1, pages: { home: { sections: { hero: { values: { title: "New" } } } } }, custom_pages: [] };
		const saved = await a.put("/v1/admin/clients/cl_ao/site/draft", { content });
		assert.equal(saved.status, 200);
		assert.deepEqual(saved.body.draft, content);
		assert.equal(seen.at(-1)!.key, KEY);
		const rejected = await a.put("/v1/admin/clients/cl_ao/site/draft", { content: { pages: { bad: {} } } });
		assert.equal(rejected.status, 400);
		assert.equal(rejected.body.error.message, "Unknown page bad");
		assert.equal((await a.post("/v1/admin/clients/cl_ao/site/publish")).body.has_unpublished_changes, false);
		assert.equal((await a.post("/v1/admin/clients/cl_ao/site/discard")).status, 200);
		assert.equal((await a.post("/v1/admin/clients/cl_ao/site/preview-token")).body.token, "preview-123");
		const actions = (await prisma.auditEntry.findMany({ where: { entityId: "cl_ao", entityType: "website" } })).map((e) => e.action).sort();
		assert.deepEqual(actions, ["website.discarded", "website.draft_saved", "website.published"]);
	});

	it("streams image uploads through to the client's backend", async () => {
		const a = await signIn("admin@platform.demo");
		await a.patch("/v1/admin/clients/cl_ao", { apiBaseUrl: fakeUrl, platformKey: KEY });
		const form = new FormData();
		form.append("image", new Blob(["PNGDATA"], { type: "image/png" }), "x.png");
		const res = await fetch(`${base}/v1/admin/clients/cl_ao/site/upload`, { method: "POST", headers: { cookie: a.cookie, origin: config.consoleOrigin }, body: form });
		assert.equal(res.status, 200);
		assert.equal((await res.json()).path, "uploads/x.png");
		assert.match(seen.at(-1)!.type!, /^multipart\/form-data; boundary=/);
	});

	it("explains connection problems", async () => {
		const a = await signIn("admin@platform.demo");
		assert.equal((await a.get("/v1/admin/clients/cl_nca/site")).body.error.code, "no_api_url");
		await a.patch("/v1/admin/clients/cl_nca", { apiBaseUrl: fakeUrl, platformKey: "w".repeat(40) });
		assert.equal((await a.get("/v1/admin/clients/cl_nca/site")).body.error.code, "platform_key_rejected");
		await a.patch("/v1/admin/clients/cl_nca", { apiBaseUrl: `${fakeUrl}/missing`, platformKey: KEY });
		assert.equal((await a.get("/v1/admin/clients/cl_nca/site")).body.error.code, "platform_disabled");
		await a.patch("/v1/admin/clients/cl_nca", { apiBaseUrl: "http://127.0.0.1:1/api" });
		const down = await a.get("/v1/admin/clients/cl_nca/site");
		assert.equal(down.status, 502);
		assert.equal(down.body.error.code, "client_unreachable");
	});

	it("needs website.write to change a site", async () => {
		const owner = await signIn("admin@platform.demo");
		await owner.patch("/v1/admin/clients/cl_ao", { apiBaseUrl: fakeUrl, platformKey: KEY });
		const support = await signIn("support@platform.demo");
		assert.equal((await support.get("/v1/admin/clients/cl_ao/site")).status, 200);
		assert.equal((await support.put("/v1/admin/clients/cl_ao/site/draft", { content: {} })).status, 403);
		assert.equal((await support.post("/v1/admin/clients/cl_ao/site/publish")).status, 403);
	});

	it("health-checks {API origin}/health when the API address is known", async () => {
		const a = await signIn("admin@platform.demo");
		await a.patch("/v1/admin/clients/cl_ao", { apiBaseUrl: fakeUrl });
		const r = await a.post("/v1/admin/clients/health-check", { ids: ["cl_ao"] });
		assert.equal(r.body.clients[0].health.state, "up");
		assert.ok(seen.some((s) => s.url === "/health"));
	});
});

describe("platform setup", () => {
	it("starts with RentBuddyz only — no clients, plans or other data", async () => {
		await wipe(prisma);
		await ensurePlatform(prisma, "owner@company.example");
		await ensurePlatform(prisma, "owner@company.example");
		assert.equal(await prisma.product.count(), 1);
		assert.equal(await prisma.client.count(), 0);
		assert.equal(await prisma.plan.count(), 0);
		assert.equal(await prisma.lead.count(), 0);
		const settings = await prisma.document.findUnique({ where: { key: "settings" } });
		assert.equal((settings!.data as { supportEmail: string }).supportEmail, "owner@company.example");
	});
});
