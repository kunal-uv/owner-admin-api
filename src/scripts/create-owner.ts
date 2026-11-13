/**
 * Sets up the platform (settings + the RentBuddyz product, if missing) and
 * creates an owner account, printing a one-time link to set its password.
 * Run again for the same email to get a fresh password-reset link.
 *
 *   npm run setup -- --email you@company.com --name "Your Name"
 */
import { prisma } from "../db.js";
import { ensurePlatform } from "../lib/bootstrap.js";
import { id } from "../lib/crypto.js";
import { issueStaffLink } from "../routes/auth.js";

const arg = (flag: string) => {
	const i = process.argv.indexOf(flag);
	return i > -1 ? process.argv[i + 1] : undefined;
};

const email = arg("--email")?.trim().toLowerCase();
const name = arg("--name")?.trim();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) {
	console.error('Usage: npm run setup -- --email you@company.com --name "Your Name"');
	process.exit(1);
}

await ensurePlatform(prisma, email);

let staff = await prisma.staff.findUnique({ where: { email } });
if (staff) {
	if (staff.role !== "owner" || staff.status === "disabled") {
		staff = await prisma.staff.update({ where: { id: staff.id }, data: { role: "owner", status: staff.status === "disabled" ? "active" : staff.status } });
	}
} else {
	staff = await prisma.staff.create({ data: { id: id("st"), email, name, role: "owner", status: "invited" } });
}
const link = await issueStaffLink(staff.id, staff.status === "invited" ? "invite" : "reset");
console.log(`\nOwner ${email} is ready. Open this link within 72 hours to set the password:\n\n  ${link}\n`);
await prisma.$disconnect();
