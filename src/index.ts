import { createApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { deliverWebhooks } from "./lib/events.js";
import { runLifecycle } from "./lib/lifecycle.js";

const app = createApp();
const server = app.listen(config.port, () => {
	console.log(`[owner-admin-api] listening on http://localhost:${config.port} (${config.env})`);
});

const timers: NodeJS.Timeout[] = [];
let lifecycleRunning = false;

async function lifecycleTick() {
	if (lifecycleRunning) return;
	lifecycleRunning = true;
	try {
		const r = await runLifecycle();
		const changed = Object.values(r).some((n) => n > 0);
		if (changed) console.log("[lifecycle]", r);
	} catch (err) {
		console.error("[lifecycle] failed", err);
	} finally {
		lifecycleRunning = false;
	}
}

if (config.lifecycleIntervalMinutes > 0) {
	timers.push(setInterval(lifecycleTick, config.lifecycleIntervalMinutes * 60_000));
	setTimeout(lifecycleTick, 5_000);
}
timers.push(setInterval(() => deliverWebhooks().catch((err) => console.error("[webhook] delivery failed", err)), 15_000));

async function shutdown(signal: string) {
	console.log(`[owner-admin-api] ${signal} — shutting down`);
	timers.forEach(clearInterval);
	server.close();
	await prisma.$disconnect();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
