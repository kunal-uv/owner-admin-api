import "dotenv/config";

const int = (value: string | undefined, fallback: number) => {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
};

const trustProxy = (value: string | undefined): boolean | string | number => {
	if (value === undefined || value === "") return "loopback";
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^\d+$/.test(value)) return Number(value);
	return value;
};

export const config = {
	env: process.env.NODE_ENV ?? "development",
	isProd: process.env.NODE_ENV === "production",
	port: int(process.env.PORT, 4100),
	consoleOrigin: process.env.CONSOLE_ORIGIN ?? "http://localhost:3100",
	consoleUrl: (process.env.CONSOLE_URL ?? "http://localhost:3100").replace(/\/$/, ""),
	trustProxy: trustProxy(process.env.TRUST_PROXY),
	webhookSecret: process.env.WEBHOOK_SECRET ?? "",
	smtpUrl: process.env.SMTP_URL ?? "",
	mailFrom: process.env.MAIL_FROM ?? "Platform <no-reply@example.com>",
	secretsKey: process.env.SECRETS_KEY ?? "",
	/**
	 * Two-factor sign-in (TOTP). Switched off for now: sign-in never asks for a
	 * code, nobody is made to set it up, and the 2FA routes return 404.
	 * Set TWO_FACTOR=on to bring it back — existing enrolments are kept.
	 */
	twoFactor: process.env.TWO_FACTOR === "on",
	healthTimeoutMs: int(process.env.HEALTH_TIMEOUT_MS, 5000),
	healthDegradedMs: int(process.env.HEALTH_DEGRADED_MS, 1500),
	lifecycleIntervalMinutes: int(process.env.LIFECYCLE_INTERVAL_MINUTES, 10),
	sessionCookie: "oa_session",
};

if (config.isProd && Buffer.from(config.secretsKey, "base64").length !== 32) {
	throw new Error("SECRETS_KEY must be 32 random bytes, base64-encoded");
}
