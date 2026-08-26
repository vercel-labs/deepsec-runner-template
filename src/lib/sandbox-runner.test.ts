import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SANDBOX_RUNNER_SOURCE } from "./sandbox-runner";

describe("Sandbox runner", () => {
  it("is valid executable ESM", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "--check", "-"], {
      input: SANDBOX_RUNNER_SOURCE,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("streams the long deepsec process and emits durable progress", () => {
    expect(SANDBOX_RUNNER_SOURCE).toContain("spawn(deepsec, deepsecArgs");
    expect(SANDBOX_RUNNER_SOURCE).toContain('progress("deepsec-running"');
  });

  it("does not mistake an agent failure for security findings", () => {
    expect(SANDBOX_RUNNER_SOURCE).toContain("status === 1 && !hasComment");
    expect(SANDBOX_RUNNER_SOURCE).toContain("agent, quota, or credential failure");
  });

  it("overrides deepsec's vulnerable optional Pi HTTP dependency", () => {
    expect(SANDBOX_RUNNER_SOURCE).toContain(
      '\"@earendil-works/pi-coding-agent\": { undici: \"8.9.0\" }',
    );
  });

  it("checkpoints completed files across Sandbox sessions", () => {
    expect(SANDBOX_RUNNER_SOURCE).toContain('const checkpointPath = path.join(RUNNER, "checkpoint.json")');
    expect(SANDBOX_RUNNER_SOURCE).toContain("executionId: cfg._executionId");
    expect(SANDBOX_RUNNER_SOURCE).toContain("analysisCounts");
    expect(SANDBOX_RUNNER_SOURCE).toContain("remainingFiles: processFiles.length");
    expect(SANDBOX_RUNNER_SOURCE).toContain('await import("minimatch")');
  });

  it("does not own trusted Workflow concurrency state", () => {
    expect(SANDBOX_RUNNER_SOURCE).not.toContain("active.lock");
  });

  it("advances the incremental baseline after complete analysis", () => {
    expect(SANDBOX_RUNNER_SOURCE).toContain("lastSuccessfulSha: targetSha");
    expect(SANDBOX_RUNNER_SOURCE).toContain('mode: "incremental"');
  });

  it("fails closed when a persistent checkout belongs to another repository", () => {
    expect(SANDBOX_RUNNER_SOURCE).toContain('remote", "get-url", "origin');
    expect(SANDBOX_RUNNER_SOURCE).toContain("Persistent Sandbox repository mismatch");
  });

  it("fails closed when deepsec records refused or skipped files", () => {
    expect(SANDBOX_RUNNER_SOURCE).toContain("function analysisFailures(checkpoint)");
    expect(SANDBOX_RUNNER_SOURCE).toContain("deepsec did not complete a trustworthy analysis");
  });

  it("preserves every pending terminal delivery across incremental reruns", () => {
    expect(SANDBOX_RUNNER_SOURCE).toContain(
      'previousOutbox?.targetSha === state.lastSuccessfulSha',
    );
    expect(SANDBOX_RUNNER_SOURCE).toContain(
      'state.lastPublishedSha !== previousOutbox.targetSha',
    );
    expect(SANDBOX_RUNNER_SOURCE).not.toContain('previousOutbox?.status === "findings"');
    expect(SANDBOX_RUNNER_SOURCE).toContain('status: "pending-delivery"');
  });
});
