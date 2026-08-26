import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowSource = fs.readFileSync(
  path.join(process.cwd(), "workflows/deepsec-repository.ts"),
  "utf8",
);

describe("Workflow security boundaries", () => {
  it("uses only the Sandbox command lifecycle as completion authority", () => {
    expect(workflowSource).toContain("activeSandbox.getCommand(command.cmdId)");
    expect(workflowSource).not.toContain("async function readRunnerStatus");
    expect(workflowSource).not.toContain('progress.stage === "complete"');
  });

  it("does not put the raw outbox summary into durable delivery metadata", () => {
    expect(workflowSource).toContain("readOutboxMetadata(activeSandbox, config)");
    expect(workflowSource).not.toContain("summary: outbox.summary,");
  });
});
