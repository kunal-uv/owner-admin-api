import { BlockList, isIP } from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Staff, StaffSession } from "@prisma/client";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { can, type Permission } from "./domain.js";
import { getSettings } from "./documents.js";
import { forbidden, HttpError, unauthorized } from "./errors.js";
import { randomToken, sha256 } from "./crypto.js";
import type { PlatformSettings } from "./types.js";

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			staff?: Staff;
			authSession?: StaffSession;
		}
	}
}

/* ─── Settings cache (read on every admin request) ────────────────────────── */

let settingsCache: { value: PlatformSettings; at: number } | null = null;

export async function cachedSettings(): Promise<PlatformSettings> {
	if (settingsCache && Date.now() - settingsCache.at < 5_000) return settingsCache.value;
	const value = await getSettings();
	settingsCache = { value, at: Date.now() };
	return value;
}

export const invalidateSettingsCache = () => {
	settingsCache = null;
};

/* ─── IP allow-list ───────────────────────────────────────────────────────── */

const normaliseIp = (ip: string) => (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip);

export function parseAllowlist(text: string): { list: BlockList; entries: number; invalid: string[] } {
	const list = new BlockList();
	const invalid: string[] = [];
	let entries = 0;
	for (const raw of text.split(/[\n,]/)) {
		const line = raw.trim();
		if (!line) continue;
		const [addr, prefix] = line.split("/");
		const family = isIP(addr);
		if (!family) {
			invalid.push(line);
			continue;
		}
		const type = family === 4 ? "ipv4" : "ipv6";
		if (prefix === undefined) list.addAddress(addr, type);
		else {
			const bits = Number(prefix);
			if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) {
				invalid.push(line);
				continue;
			}
			list.addSubnet(addr, bits, type);
		}
		entries += 1;
	}
	return { list, entries, invalid };
}

export function ipAllowed(text: string, ip: string | undefined) {
	const { list, entries } = parseAllowlist(text);
	if (entries === 0) return true;
	if (!ip) return false;
	const addr = normaliseIp(ip);
	const family = isIP(addr);
	if (!family) return false;
	return list.check(addr, family === 4 ? "ipv4" : "ipv6");
}

export const enforceIpAllowlist: RequestHandler = async (req, _res, next) => {
	const settings = await cachedSettings();
	if (!ipAllowed(settings.security.ipAllowlist, req.ip)) {
		throw new HttpError(403, "ip_not_allowed", "This network isn't on the owner console's IP allow-list.");
	}
	next();
};

/* ─── Sessions ────────────────────────────────────────────────────────────── */

export function setSessionCookie(res: Response, token: string, expiresAt: Date) {
	res.cookie(config.sessionCookie, token, {
		httpOnly: true,
		secure: config.isProd,
		sameSite: "lax",
		path: "/",
		expires: expiresAt,
	});
}

export const clearSessionCookie = (res: Response) =>
	res.clearCookie(config.sessionCookie, { httpOnly: true, secure: config.isProd, sameSite: "lax", path: "/" });

export async function createSession(req: Request, res: Response, staff: Staff, mfaPassed: boolean) {
	const settings = await cachedSettings();
	const token = randomToken();
	const expiresAt = new Date(Date.now() + Math.max(1, settings.security.sessionHours) * 3_600_000);
	const session = await prisma.staffSession.create({
		data: {
			tokenHash: sha256(token),
			staffId: staff.id,
			mfaPassed,
			expiresAt,
			ip: req.ip,
			userAgent: req.get("user-agent")?.slice(0, 300),
		},
	});
	setSessionCookie(res, token, expiresAt);
	return session;
}

/** Attaches req.staff / req.authSession when a valid session cookie is present. */
export const loadSession: RequestHandler = async (req, _res, next) => {
	const token = req.cookies?.[config.sessionCookie];
	if (typeof token === "string" && token.length > 20) {
		const session = await prisma.staffSession.findUnique({ where: { tokenHash: sha256(token) }, include: { staff: true } });
		if (session && !session.revokedAt && session.expiresAt > new Date() && session.staff.status === "active") {
			const { staff, ...rest } = session;
			req.staff = staff;
			req.authSession = rest;
			if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
				await prisma.$transaction([
					prisma.staffSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }),
					prisma.staff.update({ where: { id: staff.id }, data: { lastActiveAt: new Date() } }),
				]);
			}
		}
	}
	next();
};

function assertSignedIn(req: Request) {
	if (!req.staff || !req.authSession) throw unauthorized();
	if (config.twoFactor && req.staff.mfaEnabled && !req.authSession.mfaPassed) throw new HttpError(401, "mfa_required", "Enter your authentication code.");
}

/** Signed in and past the 2FA step. Used by /auth/me and the MFA setup routes. */
export const requireSignedIn: RequestHandler = (req, _res, next) => {
	assertSignedIn(req);
	next();
};

/** Signed in, past 2FA, and — when the platform enforces 2FA — enrolled. */
export const requireStaff: RequestHandler = async (req, _res, next) => {
	assertSignedIn(req);
	const settings = await cachedSettings();
	if (mfaSetupRequired(req.staff!, settings)) {
		throw new HttpError(403, "mfa_setup_required", "Set up two-factor authentication to continue.");
	}
	next();
};

export const requirePermission =
	(permission: Permission): RequestHandler =>
	(req: Request, _res: Response, next: NextFunction) => {
		if (!can(req.staff?.role, permission)) throw forbidden();
		next();
	};

export const mfaSetupRequired = (staff: Staff, settings: PlatformSettings) => config.twoFactor && settings.security.enforce2fa && !staff.mfaEnabled;

/** 404s the two-factor routes while TWO_FACTOR is off. */
export const requireTwoFactorOn: RequestHandler = (_req, _res, next) => {
	if (!config.twoFactor) throw new HttpError(404, "two_factor_off", "Two-factor authentication is switched off on this server.");
	next();
};

/* ─── Brute-force protection ──────────────────────────────────────────────── */

const attempts = new Map<string, { count: number; resetAt: number }>();

/** Returns false once `key` has used up `max` attempts in the window. */
export function takeAttempt(key: string, max: number, windowMs: number) {
	const now = Date.now();
	const entry = attempts.get(key);
	if (!entry || entry.resetAt < now) {
		attempts.set(key, { count: 1, resetAt: now + windowMs });
		return true;
	}
	entry.count += 1;
	return entry.count <= max;
}

export const clearAttempts = (key: string) => attempts.delete(key);

export const resetRateLimits = () => attempts.clear();
