import express, { Router, type RequestHandler } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { enforceIpAllowlist, loadSession, requireStaff } from "./lib/auth.js";
import { errorHandler, HttpError, notFoundHandler } from "./lib/errors.js";
import { authRouter } from "./routes/auth.js";
import { clientsRouter } from "./routes/clients.js";
import { plansRouter, productsRouter } from "./routes/catalog.js";
import { integrationRouter, publicRouter } from "./routes/integration.js";
import { invoicesRouter, leadsRouter, ticketsRouter } from "./routes/operations.js";
import { platformRouter } from "./routes/platform.js";
import { sitesRouter } from "./routes/sites.js";

/**
 * Cross-site request forgery guard for the cookie-authenticated admin API:
 * state-changing requests must come from the console's own origin.
 * (The session cookie is also SameSite=Lax, and bodies must be JSON.)
 */
const sameOrigin: RequestHandler = (req, _res, next) => {
	if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
	const origin = req.get("origin")?.replace(/\/+$/, "");
	if (origin) {
		// Accepted origins: the configured console, and the public address of
		// whatever proxy forwarded this request to us (Traefik → console → here,
		// via X-Forwarded-Proto/Host — only honoured from TRUST_PROXY hops). A
		// browser on another site always sends its own Origin, so it never matches.
		const allowed = new Set([config.consoleOrigin, `${req.protocol}://${req.get("host")}`, `${req.protocol}://${req.host}`]);
		if (!allowed.has(origin)) {
			throw new HttpError(
				403,
				"bad_origin",
				`Requests must come from the owner console. This one came from ${origin}, but the API's CONSOLE_ORIGIN is ${config.consoleOrigin} — set CONSOLE_ORIGIN to exactly ${origin} if that is your console.`,
			);
		}
	}
	const upload = req.path.endsWith("/site/upload") && req.is("multipart/form-data");
	if (req.headers["content-length"] && req.headers["content-length"] !== "0" && !req.is("application/json") && !upload) {
		throw new HttpError(415, "unsupported_media_type", "Send JSON.");
	}
	next();
};

export function createApp() {
	const app = express();
	app.set("trust proxy", config.trustProxy);
	app.disable("x-powered-by");
	app.use(helmet());
	app.use(express.json({ limit: "1mb" }));
	app.use(cookieParser());

	app.get("/health", async (_req, res) => {
		await prisma.$queryRaw`SELECT 1`;
		res.json({ status: "ok", time: new Date().toISOString() });
	});

	app.use("/v1/public", cors({ origin: true }), publicRouter);
	app.use("/v1/integration", integrationRouter);

	const admin = Router();
	admin.use(cors({ origin: config.consoleOrigin, credentials: true }));
	admin.use(sameOrigin);
	admin.use(enforceIpAllowlist);
	admin.use(loadSession);
	admin.use((_req, res, next) => {
		res.set("cache-control", "no-store");
		next();
	});
	admin.use("/auth", authRouter);
	admin.use(requireStaff);
	admin.use("/", platformRouter);
	admin.use("/clients/:id/site", sitesRouter);
	admin.use("/clients", clientsRouter);
	admin.use("/products", productsRouter);
	admin.use("/plans", plansRouter);
	admin.use("/leads", leadsRouter);
	admin.use("/invoices", invoicesRouter);
	admin.use("/tickets", ticketsRouter);
	app.use("/v1/admin", admin);

	app.use(notFoundHandler);
	app.use(errorHandler);
	return app;
}
