import type { Request } from "express";
import type { Tx } from "../db.js";
import type { AuditEntry } from "./types.js";

export type AuditInput = {
	action: string;
	entityType: AuditEntry["entityType"];
	entityId?: string;
	entityName?: string;
	summary: string;
	reason?: string;
};

export type Actor = { id: string; name: string; ip?: string };

export const SYSTEM: Actor = { id: "system", name: "System" };

export const actorOf = (req: Request): Actor => ({
	id: req.staff?.id ?? "system",
	name: req.staff?.name ?? "System",
	ip: req.ip,
});

/** Writes one append-only audit row inside the caller's transaction. */
export async function audit(tx: Tx, actor: Actor, entry: AuditInput) {
	await tx.auditEntry.create({
		data: {
			actorId: actor.id,
			actorName: actor.name,
			ip: actor.ip,
			action: entry.action,
			entityType: entry.entityType,
			entityId: entry.entityId,
			entityName: entry.entityName,
			summary: entry.summary.slice(0, 500),
			reason: entry.reason?.slice(0, 500),
		},
	});
}
