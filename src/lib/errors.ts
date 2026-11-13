import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";

export class HttpError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public details?: unknown,
	) {
		super(message);
	}
}

export const badRequest = (message: string, code = "bad_request", details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = "Sign in to continue.") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Your role cannot make this change.") => new HttpError(403, "forbidden", message);
export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found.`);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);

export const notFoundHandler: RequestHandler = (req, _res, next) => next(new HttpError(404, "route_not_found", `No route for ${req.method} ${req.path}`));

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
	if (err instanceof ZodError) {
		const first = err.issues[0];
		const field = first?.path.join(".");
		res.status(400).json({
			error: { code: "validation_failed", message: field ? `${field}: ${first.message}` : first?.message ?? "Invalid input.", details: err.issues },
		});
		return;
	}
	if (err instanceof HttpError) {
		res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
		return;
	}
	if (err instanceof Prisma.PrismaClientKnownRequestError) {
		if (err.code === "P2002") {
			const target = Array.isArray(err.meta?.target) ? (err.meta?.target as string[]).join(", ") : String(err.meta?.target ?? "value");
			res.status(409).json({ error: { code: "duplicate", message: `That ${target} is already in use.` } });
			return;
		}
		if (err.code === "P2025") {
			res.status(404).json({ error: { code: "not_found", message: "Resource not found." } });
			return;
		}
	}
	if (err?.type === "entity.parse.failed") {
		res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON." } });
		return;
	}
	if (err?.type === "entity.too.large") {
		res.status(413).json({ error: { code: "too_large", message: "Request body is too large." } });
		return;
	}
	console.error(`[error] ${req.method} ${req.originalUrl}`, err);
	res.status(500).json({ error: { code: "internal", message: "Something went wrong on our side." } });
};
