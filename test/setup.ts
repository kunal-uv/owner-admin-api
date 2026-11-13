import { execSync } from "node:child_process";
import dotenv from "dotenv";

// Point everything (config, Prisma) at the test database before any app code loads.
dotenv.config({ path: ".env.test", override: true });
execSync("npx prisma db push --skip-generate --accept-data-loss", { stdio: "ignore", env: process.env });
