import { repositoryConfigSchema, type RepositoryConfig } from "./schema";

// This is the deployment registry. Add and enable one entry per selected GitHub
// repository. vercel.ts derives production Cron schedules from these policies.
const definitions = [
  {
    id: "payments-api",
    enabled: false,
    repository: "acme/payments-api",
    defaultBranch: "main",
    cloneAccess: "github-app",
    issuePublication: "required",
    frequency: "0 7 * * 1",
    agent: "codex",
    model: "gpt-5.5",
    thinkingLevel: "high",
    batchSize: 2,
    priorityPaths: ["src/auth/", "src/api/", "src/billing/"],
    ignorePaths: ["**/fixtures/**", "**/dist/**"],
    promptAppend: "Prioritize authorization and payment state transitions.",
    context:
      "A multi-tenant payments API. Treat requests and webhooks as attacker-controlled.",
    deepsecVersion: "2.3.7",
    notifications: {},
    sandbox: {
      vcpus: 4,
      timeoutMs: 2_700_000,
      snapshotExpirationMs: 2_592_000_000,
    },
  },
] satisfies Array<RepositoryConfig>;

export const repositories = definitions.map((definition) =>
  repositoryConfigSchema.parse(definition),
);

export function getRepositoryConfig(id: string): RepositoryConfig | undefined {
  return repositories.find((repository) => repository.id === id);
}
