import { describe, expect, it } from "vitest";
import { sandboxNameForRepository } from "./sandbox-identity";

describe("sandboxNameForRepository", () => {
  it("is stable for the same repository regardless of GitHub casing", () => {
    expect(
      sandboxNameForRepository({ id: "payments", repository: "Acme/Payments" }),
    ).toBe(
      sandboxNameForRepository({ id: "payments", repository: "acme/payments" }),
    );
  });

  it("does not reuse persistent state when a repository id is retargeted", () => {
    expect(
      sandboxNameForRepository({ id: "payments", repository: "acme/payments" }),
    ).not.toBe(
      sandboxNameForRepository({ id: "payments", repository: "acme/ledger" }),
    );
  });
});
