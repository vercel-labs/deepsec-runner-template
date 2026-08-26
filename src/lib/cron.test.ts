import { describe, expect, it } from "vitest";
import { config } from "../../vercel";
import { repositories } from "../config/repositories";
import { buildCronJobs } from "./cron";
import { repositoryConfigSchema } from "../config/schema";

const base = {
  id: "one",
  enabled: true,
  repository: "acme/one",
  frequency: "0 7 * * 1",
  model: "gpt-5.5",
  context: "test",
};

describe("buildCronJobs", () => {
  it("emits only enabled repository schedules", () => {
    const enabled = repositoryConfigSchema.parse(base);
    const disabled = repositoryConfigSchema.parse({
      ...base,
      id: "two",
      repository: "acme/two",
      enabled: false,
    });
    expect(buildCronJobs([enabled, disabled])).toEqual([
      { path: "/api/cron/deepsec/one", schedule: "0 7 * * 1" },
    ]);
  });

  it("drives the root Vercel configuration from repository policies", () => {
    expect(config.crons).toEqual(buildCronJobs(repositories));
  });
});
