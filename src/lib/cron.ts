import type { RepositoryConfig } from "@/config/schema";

export function buildCronJobs(configs: RepositoryConfig[]) {
  return configs
    .filter((config) => config.enabled)
    .map((config) => ({
      path: `/api/cron/deepsec/${config.id}`,
      schedule: config.frequency,
    }));
}
