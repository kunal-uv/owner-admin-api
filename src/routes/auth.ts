import { Router } from "express";
import bcrypt from "bcryptjs";
import otplib from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import {
	cachedSettings,
	clearAttempts,
	clearSessionCookie,
	createSession,
	mfaSetupRequired,
	requireSignedIn,
	requireStaff,
	requireTwoFactorOn,
	takeAttempt,
} from "../lib/auth.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { badRequest, HttpError, unauthorized } from "../lib/errors.js";
import { email, password } from "../lib/schemas.js";
import { staffOut } from "../lib/serialize.js";
import type { Staff } from "@prisma/client";
import type { Me } from "../lib/types.js";

const { authenticator } = otplib;
authenticator.options = { window: 1 };

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export const meOut = async (staff: Staff): Promise<Me> => ({ ...staffOut(staff), mfaSetupRequired: mfaSetupRequired(staff, await cachedSettings()) });

const actor = (staff: Staff, ip?: string) => ({ id: staff.id, name: staff.name, ip });

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
	const body = z.object({ email, password: z.string().min(1).max(200) }).parse(req.body);
	const key = `login:${req.ip}:${body.email}`;
	if (!takeAttempt(key, 10, 15 * 60_000) || !takeAttempt(`login-ip:${req.ip}`, 50, 15 * 60_000)) {
		throw new HttpError(429, "too_many_attempts", "Too many sign-in attempts. Wait 15 minutes and try again.");
	}
	const staff = await prisma.staff.findUnique({ where: { email: body.email } });
	const ok = await bcrypt.compare(body.password, staff?.passwordHash ?? DUMMY_HASH);
	if (!staff || !staff.passwordHash || !ok) throw new HttpError(401, "invalid_credentials", "Email or password is incorrect.");
	if (staff.status !== "active") throw new HttpError(403, "account_inactive", "This account is not active.");
	clearAttempts(key);

	const needsCode = config.twoFactor && staff.mfaEnabled;
	await createSession(req, res, staff, !needsCode);
	if (needsCode) {
		res.json({ mfaRequired: true });
		return;
	}
	await prisma.$transaction(async (tx) => {
		await tx.staff.update({ where: { id: staff.id }, data: { lastActiveAt: new Date() } });
		await audit(tx, actor(staff, req.ip), { action: "session.login", entityType: "session", entityName: staff.email, summary: "Signed in to the owner console" });
	});
	res.json({ mfaRequired: false, me: await meOut(staff) });
});

authRouter.post("/mfa/verify", requireTwoFactorOn, async (req, res) => {
	const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }).parse(req.body);
	const staff = req.staff;
	const session = req.authSession;
	if (!staff || !session) throw unauthorized();
	if (!staff.mfaEnabled || session.mfaPassed) throw badRequest("No authentication code is needed for this session.");
	if (!takeAttempt(`mfa:${session.id}`, 6, 15 * 60_000)) {
		await prisma.staffSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
		clearSessionCookie(res);
		throw new HttpError(429, "too_many_attempts", "Too many wrong codes. Sign in again.");
	}
	if (!staff.mfaSecret || !authenticator.verify({ token: code, secret: staff.mfaSecret })) {
		throw new HttpError(401, "invalid_code", "That code isn't right. Check your authenticator app and try again.");
	}
	await prisma.$transaction(async (tx) => {
		await tx.staffSession.update({ where: { id: session.id }, data: { mfaPassed: true } });
		await tx.staff.update({ where: { id: staff.id }, data: { lastActiveAt: new Date() } });
		await audit(tx, actor(staff, req.ip), { action: "session.login", entityType: "session", entityName: staff.email, summary: "Signed in to the owner console (2FA)" });
	});
	res.json({ me: await meOut(staff) });
});

authRouter.post("/logout", async (req, res) => {
	if (req.authSession) await prisma.staffSession.update({ where: { id: req.authSession.id }, data: { revokedAt: new Date() } });
	clearSessionCookie(res);
	res.json({ ok: true });
});

authRouter.get("/me", requireSignedIn, async (req, res) => {
	res.json({ me: await meOut(req.staff!) });
});

/* ─── Two-factor setup ───────────────────────────────────────────────────── */

authRouter.post("/mfa/setup", requireTwoFactorOn, requireSignedIn, async (req, res) => {
	const staff = req.staff!;
	if (staff.mfaEnabled) throw badRequest("Two-factor authentication is already on.");
	const secret = authenticator.generateSecret();
	await prisma.staff.update({ where: { id: staff.id }, data: { mfaPendingSecret: secret } });
	const settings = await cachedSettings();
	const otpauthUrl = authenticator.keyuri(staff.email, `${settings.brandName} owner console`, secret);
	res.json({ secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 200 }) });
});

authRouter.post("/mfa/enable", requireTwoFactorOn, requireSignedIn, async (req, res) => {
	const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }).parse(req.body);
	const staff = await prisma.staff.findUniqueOrThrow({ where: { id: req.staff!.id } });
	if (!staff.mfaPendingSecret) throw badRequest("Start the setup again.");
	if (!authenticator.verify({ token: code, secret: staff.mfaPendingSecret })) throw new HttpError(400, "invalid_code", "That code isn't right. Check the time on your phone and try again.");
	const updated = await prisma.$transaction(async (tx) => {
		const s = await tx.staff.update({ where: { id: staff.id }, data: { mfaEnabled: true, mfaSecret: staff.mfaPendingSecret, mfaPendingSecret: null } });
		await tx.staffSession.update({ where: { id: req.authSession!.id }, data: { mfaPassed: true } });
		await audit(tx, actor(staff, req.ip), { action: "staff.mfa_enabled", entityType: "staff", entityId: staff.id, entityName: staff.email, summary: "Turned on two-factor authentication" });
		return s;
	});
	res.json({ me: await meOut(updated) });
});

authRouter.post("/mfa/disable", requireTwoFactorOn, requireStaff, async (req, res) => {
	const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }).parse(req.body);
	const staff = req.staff!;
	const settings = await cachedSettings();
	if (settings.security.enforce2fa) throw badRequest("Two-factor authentication is required for everyone on this console.");
	if (!staff.mfaEnabled || !staff.mfaSecret) throw badRequest("Two-factor authentication is already off.");
	if (!authenticator.verify({ token: code, secret: staff.mfaSecret })) throw new HttpError(400, "invalid_code", "That code isn't right.");
	const updated = await prisma.$transaction(async (tx) => {
		const s = await tx.staff.update({ where: { id: staff.id }, data: { mfaEnabled: false, mfaSecret: null } });
		await audit(tx, actor(staff, req.ip), { action: "staff.mfa_disabled", entityType: "staff", entityId: staff.id, entityName: staff.email, summary: "Turned off two-factor authentication" });
		return s;
	});
	res.json({ me: await meOut(updated) });
});

authRouter.post("/password", requireSignedIn, async (req, res) => {
	const body = z.object({ currentPassword: z.string().min(1), newPassword: password }).parse(req.body);
	const staff = req.staff!;
	if (!staff.passwordHash || !(await bcrypt.compare(body.currentPassword, staff.passwordHash))) {
		throw new HttpError(400, "invalid_credentials", "Current password is incorrect.");
	}
	await prisma.$transaction(async (tx) => {
		await tx.staff.update({ where: { id: staff.id }, data: { passwordHash: await bcrypt.hash(body.newPassword, 12) } });
		// Sign out every other device.
		await tx.staffSession.updateMany({ where: { staffId: staff.id, id: { not: req.authSession!.id }, revokedAt: null }, data: { revokedAt: new Date() } });
		await audit(tx, actor(staff, req.ip), { action: "staff.password_changed", entityType: "staff", entityId: staff.id, entityName: staff.email, summary: "Changed password and signed out other sessions" });
	});
	res.json({ ok: true });
});

/* ─── Invite / reset links (no session) ───────────────────────────────────── */

async function findToken(token: string) {
	const row = await prisma.staffToken.findUnique({ where: { tokenHash: sha256(token) }, include: { staff: true } });
	if (!row || row.usedAt || row.expiresAt < new Date()) throw new HttpError(410, "link_expired", "This link has expired or was already used. Ask an owner for a new one.");
	return row;
}

authRouter.get("/token/:token", async (req, res) => {
	const row = await findToken(String(req.params.token));
	res.json({ purpose: row.purpose, email: row.staff.email, name: row.staff.name });
});

authRouter.post("/token/accept", async (req, res) => {
	const body = z.object({ token: z.string().min(20).max(200), password }).parse(req.body);
	if (!takeAttempt(`token:${req.ip}`, 20, 15 * 60_000)) throw new HttpError(429, "too_many_attempts", "Too many attempts. Try again later.");
	const row = await findToken(body.token);
	if (row.staff.status === "disabled") throw new HttpError(403, "account_inactive", "This account is disabled.");
	await prisma.$transaction(async (tx) => {
		const used = await tx.staffToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
		if (!used.count) throw new HttpError(410, "link_expired", "This link was already used.");
		await tx.staff.update({ where: { id: row.staffId }, data: { passwordHash: await bcrypt.hash(body.password, 12), status: "active" } });
		await tx.staffSession.updateMany({ where: { staffId: row.staffId, revokedAt: null }, data: { revokedAt: new Date() } });
		await audit(tx, { id: row.staff.id, name: row.staff.name, ip: req.ip }, {
			action: row.purpose === "invite" ? "staff.invite_accepted" : "staff.password_reset",
			entityType: "staff",
			entityId: row.staffId,
			entityName: row.staff.email,
			summary: row.purpose === "invite" ? "Accepted invitation and set a password" : "Reset password from emailed link",
		});
	});
	res.json({ ok: true, email: row.staff.email });
});

/** Creates a single-use invite or reset link (72h). Returns the URL so owners can copy it. */
export async function issueStaffLink(staffId: string, purpose: "invite" | "reset") {
	const token = randomToken();
	await prisma.staffToken.updateMany({ where: { staffId, purpose, usedAt: null }, data: { usedAt: new Date() } });
	await prisma.staffToken.create({ data: { tokenHash: sha256(token), staffId, purpose, expiresAt: new Date(Date.now() + 72 * 3_600_000) } });
	return `${config.consoleUrl}/accept-invite?token=${token}`;
}
