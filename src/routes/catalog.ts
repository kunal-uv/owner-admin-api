import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { actorOf, audit } from "../lib/audit.js";
import { requirePermission } from "../lib/auth.js";
import { id, randomToken, sha256 } from "../lib/crypto.js";
import { toCents } from "../lib/domain.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { emit } from "../lib/events.js";
import { planSchema, productSchema } from "../lib/schemas.js";
import { planOut, productOut } from "../lib/serialize.js";
import type { FeatureDef } from "../lib/types.js";

/* ─── Products ────────────────────────────────────────────────────────────── */

export const productsRouter = Router();

productsRouter.post("/", requirePermission("products.write"), async (req, res) => {
	const body = productSchema.parse(req.body);
	if (await prisma.product.findUnique({ where: { key: body.key } })) throw conflict("That product key is already used.", "key_taken");
	const product = await prisma.$transaction(async (tx) => {
		const p = await tx.product.create({ data: { id: id("prd"), ...body, features: body.features as never } });
		await audit(tx, actorOf(req), { action: "product.created", entityType: "product", entityId: p.id, entityName: p.name, summary: "Added product" });
		return p;
	});
	res.status(201).json({ product: productOut(product) });
});

productsRouter.put("/:id", requirePermission("products.write"), async (req, res) => {
	const body = productSchema.parse(req.body);
	const current = await prisma.product.findUnique({ where: { id: String(req.params.id) } });
	if (!current) throw notFound("Product");
	if (body.key !== current.key) throw badRequest("A product's key can't change — products and plans depend on it.");
	// A feature still used by a plan or a client override can't be removed from the catalogue.
	const keys = new Set(body.features.map((f) => f.key));
	const removed = (current.features as unknown as FeatureDef[]).map((f) => f.key).filter((k) => !keys.has(k));
	if (removed.length) {
		const plans = await prisma.plan.findMany({ where: { productId: current.id, features: { hasSome: removed } }, select: { name: true } });
		if (plans.length) throw conflict(`Remove ${removed.join(", ")} from the ${plans.map((p) => p.name).join(", ")} plan first.`, "feature_in_use");
	}
	const product = await prisma.$transaction(async (tx) => {
		const p = await tx.product.update({ where: { id: current.id }, data: { ...body, features: body.features as never } });
		if (removed.length) {
			// Drop per-client overrides that point at features which no longer exist.
			const clients = await tx.client.findMany({ where: { productId: current.id }, select: { id: true, featureOverrides: true } });
			for (const c of clients) {
				const overrides = { ...(c.featureOverrides as Record<string, boolean>) };
				if (removed.some((k) => k in overrides)) {
					removed.forEach((k) => delete overrides[k]);
					await tx.client.update({ where: { id: c.id }, data: { featureOverrides: overrides } });
				}
			}
		}
		await audit(tx, actorOf(req), { action: "product.updated", entityType: "product", entityId: p.id, entityName: p.name, summary: "Updated product" });
		return p;
	});
	res.json({ product: productOut(product) });
});

/** Issues (or rotates) the key the product's backend uses to call the integration API. Shown once. */
productsRouter.post("/:id/service-key", requirePermission("products.write"), async (req, res) => {
	const current = await prisma.product.findUnique({ where: { id: String(req.params.id) } });
	if (!current) throw notFound("Product");
	const key = `sk_${current.key}_${randomToken(24)}`;
	await prisma.$transaction(async (tx) => {
		await tx.product.update({ where: { id: current.id }, data: { serviceKeyHash: sha256(key), serviceKeyHint: key.slice(-4) } });
		await audit(tx, actorOf(req), {
			action: current.serviceKeyHash ? "product.key_rotated" : "product.key_issued",
			entityType: "product",
			entityId: current.id,
			entityName: current.name,
			summary: current.serviceKeyHash ? "Rotated the service API key (old key stopped working)" : "Issued a service API key",
		});
	});
	res.json({ key, hint: key.slice(-4) });
});

/* ─── Plans ───────────────────────────────────────────────────────────────── */

export const plansRouter = Router();

function planData(body: z.infer<typeof planSchema>, featureKeys: Set<string>, coreKeys: string[]) {
	const unknown = body.features.filter((k) => !featureKeys.has(k));
	if (unknown.length) throw badRequest(`Unknown features: ${unknown.join(", ")}`);
	return {
		name: body.name,
		code: body.code,
		description: body.description,
		currency: body.currency,
		priceMonthlyCents: toCents(body.priceMonthly),
		priceYearlyCents: toCents(body.priceYearly),
		trialDays: body.trialDays,
		limits: body.limits,
		features: Array.from(new Set([...coreKeys, ...body.features])),
		isPublic: body.isPublic,
		highlighted: body.highlighted ?? false,
		sortOrder: body.sortOrder,
	};
}

async function productFeatures(productId: string) {
	const product = await prisma.product.findUnique({ where: { id: productId } });
	if (!product) throw notFound("Product");
	const features = product.features as unknown as FeatureDef[];
	return { product, keys: new Set(features.map((f) => f.key)), core: features.filter((f) => f.core).map((f) => f.key) };
}

plansRouter.post("/", requirePermission("plans.write"), async (req, res) => {
	const body = planSchema.parse(req.body);
	const { keys, core } = await productFeatures(body.productId);
	if (await prisma.plan.findUnique({ where: { code: body.code } })) throw conflict("That plan code is already used.", "code_taken");
	const plan = await prisma.$transaction(async (tx) => {
		const data = planData(body, keys, core);
		if (data.highlighted) await tx.plan.updateMany({ where: { productId: body.productId, highlighted: true }, data: { highlighted: false } });
		const p = await tx.plan.create({ data: { id: id("pl"), productId: body.productId, status: "active", ...data } });
		await audit(tx, actorOf(req), { action: "plan.created", entityType: "plan", entityId: p.id, entityName: p.name, summary: `Created plan at ${body.priceMonthly}/mo` });
		return p;
	});
	res.status(201).json({ plan: planOut(plan) });
});

plansRouter.put("/:id", requirePermission("plans.write"), async (req, res) => {
	const body = planSchema.parse(req.body);
	const current = await prisma.plan.findUnique({ where: { id: String(req.params.id) } });
	if (!current) throw notFound("Plan");
	if (body.productId !== current.productId) throw badRequest("A plan can't move to another product.");
	if (body.code !== current.code && (await prisma.plan.findUnique({ where: { code: body.code } }))) throw conflict("That plan code is already used.", "code_taken");
	const { keys, core } = await productFeatures(current.productId);
	const plan = await prisma.$transaction(async (tx) => {
		const data = planData(body, keys, core);
		if (data.highlighted) await tx.plan.updateMany({ where: { productId: current.productId, highlighted: true, id: { not: current.id } }, data: { highlighted: false } });
		const p = await tx.plan.update({ where: { id: current.id }, data });
		const changes: string[] = [];
		if (p.priceMonthlyCents !== current.priceMonthlyCents || p.priceYearlyCents !== current.priceYearlyCents) changes.push("prices");
		if (JSON.stringify(p.limits) !== JSON.stringify(current.limits)) changes.push("limits");
		if ([...p.features].sort().join() !== [...current.features].sort().join()) changes.push("features");
		await audit(tx, actorOf(req), { action: "plan.updated", entityType: "plan", entityId: p.id, entityName: p.name, summary: `Updated plan${changes.length ? ` (${changes.join(", ")})` : ""}` });
		return p;
	});
	const clients = await prisma.client.findMany({ where: { planId: plan.id }, select: { id: true, slug: true } });
	for (const c of clients) await emit("entitlements.changed", { clientId: c.id, slug: c.slug });
	res.json({ plan: planOut(plan) });
});

plansRouter.post("/:id/status", requirePermission("plans.write"), async (req, res) => {
	const { status } = z.object({ status: z.enum(["active", "archived"]) }).parse(req.body);
	const current = await prisma.plan.findUnique({ where: { id: String(req.params.id) } });
	if (!current) throw notFound("Plan");
	if (current.status === status) throw badRequest(`The plan is already ${status}.`);
	const plan = await prisma.$transaction(async (tx) => {
		const p = await tx.plan.update({ where: { id: current.id }, data: { status, highlighted: status === "archived" ? false : current.highlighted } });
		await audit(tx, actorOf(req), {
			action: `plan.${status}`,
			entityType: "plan",
			entityId: p.id,
			entityName: p.name,
			summary: status === "archived" ? "Archived plan — existing clients keep it" : "Restored plan",
		});
		return p;
	});
	res.json({ plan: planOut(plan) });
});
