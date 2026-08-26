import { afterEach, describe, expect, it, vi } from "vitest";
import { getGitHubInstallationToken, publishGitHubIssue } from "./github";
import { repositoryConfigSchema } from "../config/schema";

const { getTokenMock, graphqlMock, listForRepoMock, updateMock, createMock } =
  vi.hoisted(() => ({
    getTokenMock: vi.fn(),
    graphqlMock: vi.fn(),
    listForRepoMock: vi.fn(),
    updateMock: vi.fn(),
    createMock: vi.fn(),
  }));

vi.mock("@vercel/connect", () => ({ getToken: getTokenMock }));
vi.mock("@octokit/rest", () => ({
  Octokit: class {
    graphql = graphqlMock;
    paginate = vi.fn(async () => listForRepoMock());
    rest = {
      issues: {
        listForRepo: listForRepoMock,
        update: updateMock,
        create: createMock,
      },
    };
  },
}));

const config = repositoryConfigSchema.parse({
  id: "payments",
  enabled: true,
  repository: "acme/payments",
  frequency: "0 7 * * 1",
  model: "gpt-5.5",
  context: "Payments service",
});

const outbox = {
  mode: "incremental" as const,
  status: "findings" as const,
  repository: "acme/payments",
  branch: "main",
  baseSha: null,
  targetSha: "a".repeat(40),
  files: ["src/index.ts"],
  findingsCount: 1,
  findingsBySeverity: { HIGH: 1 },
  summary: "One finding",
  startedAt: "2026-08-24T00:00:00.000Z",
  completedAt: "2026-08-24T00:01:00.000Z",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GitHub issue publication", () => {
  it("does not reflect connector error details into Workflow failures", async () => {
    vi.stubEnv("GITHUB_CONNECTOR", "github/deepsec-scanner");
    getTokenMock.mockRejectedValue(
      new Error("authorization: Bearer secret-installation-token"),
    );

    const error = await getGitHubInstallationToken("acme/payments", [
      "contents:read",
    ]).catch((caught: unknown) => caught);

    expect(String(error)).toContain("Could not obtain");
    expect(String(error)).not.toContain("secret-installation-token");
  });

  it("requires a secret marker instead of publishing a predictable marker", async () => {
    getTokenMock.mockResolvedValue("installation-token");
    listForRepoMock.mockResolvedValue([]);

    await expect(
      publishGitHubIssue(config, outbox, "wrun_1", "sandbox-1"),
    ).rejects.toThrow("DEEPSEC_MARKER_SECRET");
  });

  it("reopens and updates a matching runner issue", async () => {
    vi.stubEnv("DEEPSEC_MARKER_SECRET", "test-only-marker-secret");
    vi.stubEnv("GITHUB_CONNECTOR", "github/deepsec-scanner");
    getTokenMock.mockResolvedValue("installation-token");
    graphqlMock.mockResolvedValue({ viewer: { login: "deepsec-bot" } });
    listForRepoMock.mockImplementation(() => {
      const body = String(createMock.mock.calls[0]?.[0]?.body ?? "");
      if (!body) return [];
      return [
        {
          number: 99,
          body,
          state: "open",
          user: { login: "attacker" },
        },
        {
          number: 42,
          body,
          state: "closed",
          user: { login: "deepsec-bot" },
        },
      ];
    });
    createMock.mockResolvedValue({ data: { html_url: "https://github.test/42" } });
    updateMock.mockResolvedValue({ data: { html_url: "https://github.test/42" } });

    const first = await publishGitHubIssue(
      config,
      outbox,
      "wrun_1",
      "sandbox-1",
    );
    const second = await publishGitHubIssue(
      config,
      outbox,
      "wrun_2",
      "sandbox-1",
    );

    expect(first.action).toBe("created");
    expect(second.action).toBe("updated");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, state: "open" }),
    );
    const marker = String(createMock.mock.calls[0][0].body).split("\n")[0];
    expect(marker).toMatch(/^<!-- deepsec-runner:[0-9a-f]{64} -->$/);
    expect(marker).not.toContain(outbox.targetSha);
  });

  it("does not reflect provider request metadata from publication failures", async () => {
    vi.stubEnv("DEEPSEC_MARKER_SECRET", "test-only-marker-secret");
    vi.stubEnv("GITHUB_CONNECTOR", "github/deepsec-scanner");
    getTokenMock.mockResolvedValue("installation-token");
    graphqlMock.mockResolvedValue({ viewer: { login: "deepsec-bot" } });
    listForRepoMock.mockRejectedValue(
      new Error("authorization: Bearer secret-installation-token"),
    );

    const error = await publishGitHubIssue(
      config,
      outbox,
      "wrun_1",
      "sandbox-1",
    ).catch((caught: unknown) => caught);

    expect(String(error)).toContain("GitHub issue publication failed");
    expect(String(error)).not.toContain("secret-installation-token");
  });
});
