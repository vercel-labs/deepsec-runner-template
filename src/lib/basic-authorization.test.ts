import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { basicAuthorization } from "./basic-authorization";

describe("Basic authorization", () => {
  it("encodes ASCII credentials with a Workflow-compatible Web API", () => {
    expect(basicAuthorization("Aladdin", "open sesame")).toBe(
      "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
    );
  });

  it("keeps the Node-only Buffer global out of the Workflow module", () => {
    const workflowSource = readFileSync(
      new URL("../../workflows/deepsec-repository.ts", import.meta.url),
      "utf8",
    );

    expect(workflowSource).not.toMatch(/\bBuffer\b/);
  });
});
