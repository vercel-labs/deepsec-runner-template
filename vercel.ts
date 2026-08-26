import type { VercelConfig } from "@vercel/config/v1";
import { repositories } from "./src/config/repositories";
import { buildCronJobs } from "./src/lib/cron";

export const config = {
  crons: buildCronJobs(repositories),
} satisfies VercelConfig;
