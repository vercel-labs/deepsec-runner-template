import type { RepositoryConfig } from "../config/schema";
import { outboxSchema, type DeepsecOutbox } from "../config/schema";

const MAX_OUTBOX_BYTES = 512 * 1024;

export type OutboxDeliveryMetadata = Pick<
  DeepsecOutbox,
  | "mode"
  | "status"
  | "targetSha"
  | "findingsCount"
  | "findingsBySeverity"
  | "completedAt"
> & {
  filesAnalyzed: number;
};

export function parseSandboxOutbox(
  content: Buffer | null,
  config: RepositoryConfig,
): DeepsecOutbox {
  if (!content) throw new Error("Sandbox completed without an outbox");
  if (content.byteLength > MAX_OUTBOX_BYTES) {
    throw new Error("Sandbox outbox exceeds the maximum allowed size");
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("Sandbox outbox is not valid JSON");
  }

  const parsed = outboxSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("Sandbox outbox failed schema validation");
  if (
    parsed.data.repository !== config.repository ||
    parsed.data.branch !== config.defaultBranch
  ) {
    throw new Error("Sandbox outbox does not match the configured repository");
  }
  return parsed.data;
}

export function deliveryMetadata(
  outbox: DeepsecOutbox,
): OutboxDeliveryMetadata {
  return {
    mode: outbox.mode,
    status: outbox.status,
    targetSha: outbox.targetSha,
    filesAnalyzed: outbox.files.length,
    findingsCount: outbox.findingsCount,
    findingsBySeverity: outbox.findingsBySeverity,
    completedAt: outbox.completedAt,
  };
}
