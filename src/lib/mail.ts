import nodemailer from "nodemailer";
import { prisma } from "../db.js";
import { config } from "../config.js";

const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;

/**
 * Sends an email, or — without SMTP configured — records it in email_outbox
 * and the server log so nothing is silently lost in development.
 */
export async function sendMail(to: string, subject: string, text: string) {
	if (!transport) {
		await prisma.emailOutbox.create({ data: { to, subject, text, status: "logged" } });
		if (config.env !== "test") console.log(`[mail] (not sent, SMTP_URL empty) to=${to} subject="${subject}"\n${text}\n`);
		return;
	}
	try {
		await transport.sendMail({ from: config.mailFrom, to, subject, text });
		await prisma.emailOutbox.create({ data: { to, subject, text, status: "sent" } });
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		await prisma.emailOutbox.create({ data: { to, subject, text, status: "failed", error } });
		console.error(`[mail] failed to=${to}: ${error}`);
	}
}
