import { describe, expect, it } from "vitest";
import { repositoryConfigSchema } from "../config/schema";
import { deliveryMetadata, parseSandboxOutbox } from "./outbox";

const config = repositoryConfigSchema.parse({
  id: "payments",
  enabled: true,
  repository: "acme/payments",
  frequency: "0 7 * * 1",
  model: "gpt-5.5",
  context: "Payments service",
});

function encodedOutbox(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      mode: "incremental",
      status: "findings",
      repository: "acme/payments",
      branch: "main",
      baseSha: null,
      targetSha: "a".repeat(40),
      files: ["src/index.ts"],
      findingsCount: 1,
      findingsBySeverity: { HIGH: 1 },
      summary: "Sensitive finding details",
      startedAt: "2026-08-24T00:00:00.000Z",
      completedAt: "2026-08-24T00:01:00.000Z",
      ...overrides,
    }),
  );
}

describe("Sandbox outbox validation", () => {
  it("returns delivery metadata without retaining the findings summary", () => {
    const metadata = deliveryMetadata(parseSandboxOutbox(encodedOutbox(), config));

    expect(metadata).toMatchObject({
      status: "findings",
      targetSha: "a".repeat(40),
      filesAnalyzed: 1,
    });
    expect(metadata).not.toHaveProperty("summary");
  });

  it("rejects an outbox that tries to change the trusted repository binding", () => {
    expect(() =>
      parseSandboxOutbox(
        encodedOutbox({ repository: "attacker/controlled" }),
        config,
      ),
    ).toThrow("does not match the configured repository");
  });

  it("rejects unbounded or malformed untrusted output without echoing it", () => {
    const secret = "do-not-reflect-this-value";
    const malformed = Buffer.from(JSON.stringify({ summary: secret }));

    expect(() => parseSandboxOutbox(malformed, config)).toThrow(
      "Sandbox outbox failed schema validation",
    );
    try {
      parseSandboxOutbox(malformed, config);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("rejects attacker-controlled severity labels instead of persisting them", () => {
    const secret = "SECRET_AS_SEVERITY";

    expect(() =>
      parseSandboxOutbox(
        encodedOutbox({ findingsBySeverity: { [secret]: 1 } }),
        config,
      ),
    ).toThrow("Sandbox outbox failed schema validation");
  });
});
