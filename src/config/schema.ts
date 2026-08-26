import { z } from "zod";

const cronSchema = z
  .string()
  .trim()
  .regex(/^(\S+\s+){4}\S+$/, "Use a five-field Vercel cron expression");

export const repositoryConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  enabled: z.boolean().default(false),
  repository: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use a GitHub owner/repository name"),
  defaultBranch: z.string().min(1).default("main"),
  cloneAccess: z.enum(["github-app", "public"]).default("github-app"),
  issuePublication: z.enum(["required", "slack-only"]).default("required"),
  frequency: cronSchema,
  agent: z.enum(["codex", "claude", "pi"]).default("codex"),
  model: z.string().min(1),
  thinkingLevel: z.enum(["minimal", "low", "medium", "high", "xhigh"]).default("high"),
  batchSize: z.number().int().min(1).max(20).default(5),
  priorityPaths: z.array(z.string()).default([]),
  ignorePaths: z.array(z.string()).default([]),
  promptAppend: z.string().default(""),
  context: z.string().min(1),
  deepsecVersion: z.string().min(1).default("2.3.7"),
  notifications: z
    .object({
      slackChannelId: z.string().regex(/^[CGD][A-Z0-9]+$/).optional(),
    })
    .default({}),
  sandbox: z
    .object({
      vcpus: z.number().int().min(1).max(8).default(4),
      timeoutMs: z.number().int().min(60_000).max(86_400_000).default(2_700_000),
      snapshotExpirationMs: z.number().int().nonnegative().default(2_592_000_000),
    })
    .default({ vcpus: 4, timeoutMs: 2_700_000, snapshotExpirationMs: 2_592_000_000 }),
});

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

const gitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
const repositoryPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (file) =>
      !file.startsWith("/") &&
      !file.split("/").includes("..") &&
      !file.includes("\\"),
    "Files must be repository-relative paths",
  );
const findingCountSchema = z.number().int().nonnegative();
const findingsBySeveritySchema = z
  .object({
    CRITICAL: findingCountSchema.optional(),
    HIGH: findingCountSchema.optional(),
    MEDIUM: findingCountSchema.optional(),
    HIGH_BUG: findingCountSchema.optional(),
    BUG: findingCountSchema.optional(),
    LOW: findingCountSchema.optional(),
  })
  .strict()
  .default({});

export const outboxSchema = z.object({
  mode: z.literal("incremental").default("incremental"),
  status: z.enum(["clean", "findings", "no-changes"]),
  repository: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: z.string().min(1).max(255),
  baseSha: gitShaSchema.nullable(),
  targetSha: gitShaSchema,
  files: z.array(repositoryPathSchema).max(10_000),
  findingsCount: findingCountSchema.default(0),
  findingsBySeverity: findingsBySeveritySchema,
  summary: z.string().max(60_000),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
});

export type DeepsecOutbox = z.infer<typeof outboxSchema>;
