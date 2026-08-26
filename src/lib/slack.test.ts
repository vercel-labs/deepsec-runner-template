import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSlackMessage,
  sendSlackNotification,
  SlackConfigurationError,
  SlackDeliveryError,
} from "./slack";

const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn() }));

vi.mock("@vercel/connect", () => ({ getToken: getTokenMock }));

afterEach(() => {
  getTokenMock.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Slack notifications", () => {
  it("includes a GitHub issue when findings were published", () => {
    const message = buildSlackMessage({
      runId: "wrun_123",
      repository: "acme/payments",
      status: "findings",
      targetSha: "1234567890abcdef",
      filesAnalyzed: 12,
      findingsCount: 2,
      findingsBySeverity: { HIGH: 1, MEDIUM: 1 },
      summary: "Sensitive repository finding detail",
      issueUrl: "https://github.com/acme/payments/issues/42",
      completedAt: "2026-08-20T10:00:00.000Z",
    });

    expect(JSON.stringify(message)).toContain("Open GitHub issue");
    expect(JSON.stringify(message)).not.toContain("Sensitive repository finding detail");
    expect(message.text).toContain("findings require review");
  });

  it("sanitizes failure messages before posting", () => {
    const message = buildSlackMessage({
      runId: "wrun_456",
      repository: "acme/api",
      status: "failed",
      errorMessage: "request <script> & failed",
      completedAt: "2026-08-20T10:00:00.000Z",
    });

    expect(JSON.stringify(message)).toContain("&lt;script&gt; &amp; failed");
  });

  it("includes escaped findings for Slack-only repositories", () => {
    const message = buildSlackMessage({
      runId: "wrun_public",
      repository: "acme/public-site",
      status: "findings",
      findingsCount: 1,
      findingsBySeverity: { HIGH: 1 },
      summary: "### HIGH · app/page.tsx\nAttacker-controlled <script> reaches rendering.",
      completedAt: "2026-08-20T10:00:00.000Z",
    });

    const serialized = JSON.stringify(message);
    expect(serialized).toContain("Slack-only publication");
    expect(serialized).toContain("Findings report");
    expect(serialized).toContain("&lt;script&gt;");
    expect(serialized).not.toContain("Open GitHub issue");
  });

  it("escapes severity labels before rendering Slack mrkdwn", () => {
    const message = buildSlackMessage({
      runId: "wrun_severity",
      repository: "acme/api",
      status: "findings",
      findingsCount: 1,
      findingsBySeverity: { "<!channel>": 1 },
      completedAt: "2026-08-20T10:00:00.000Z",
    });

    const serialized = JSON.stringify(message);
    expect(serialized).toContain("&lt;!channel&gt;");
    expect(serialized).not.toContain("<!channel>");
  });

  it("fails when required Slack configuration is missing", async () => {
    vi.stubEnv("SLACK_CONNECTOR", "");
    vi.stubEnv("SLACK_CHANNEL_ID", "");

    await expect(
      sendSlackNotification(
        {
          runId: "wrun_missing",
          repository: "acme/api",
          status: "clean",
          completedAt: "2026-08-20T10:00:00.000Z",
        },
        "step_missing",
      ),
    ).rejects.toBeInstanceOf(SlackConfigurationError);
  });

  it("does not reflect connector error details into Workflow failures", async () => {
    vi.stubEnv("SLACK_CONNECTOR", "slack/deepsec-notifier");
    vi.stubEnv("SLACK_CHANNEL_ID", "C0123456789");
    getTokenMock.mockRejectedValue(
      new Error("authorization: Bearer xoxb-secret-token"),
    );

    const error = await sendSlackNotification(
      {
        runId: "wrun_connector_failure",
        repository: "acme/api",
        status: "failed",
        completedAt: "2026-08-20T10:00:00.000Z",
      },
      "step_connector_failure",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SlackDeliveryError);
    expect(String(error)).not.toContain("xoxb-secret-token");
  });

  it("uses a stable Slack client message ID across step retries", async () => {
    vi.stubEnv("SLACK_CONNECTOR", "slack/deepsec-notifier");
    vi.stubEnv("SLACK_CHANNEL_ID", "C0123456789");
    getTokenMock.mockResolvedValue("xoxb-test");
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, ts: "123.456" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const notification = {
      runId: "wrun_retry",
      repository: "acme/api",
      status: "clean" as const,
      completedAt: "2026-08-20T10:00:00.000Z",
    };

    await sendSlackNotification(notification, "step_stable");
    await sendSlackNotification(notification, "step_stable");

    const messageIds = fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { client_msg_id: string };
      return body.client_msg_id;
    });
    expect(messageIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(messageIds[1]).toBe(messageIds[0]);
  });

  it("preserves Slack's retry-after delay for Workflow retries", async () => {
    vi.stubEnv("SLACK_CONNECTOR", "slack/deepsec-notifier");
    vi.stubEnv("SLACK_CHANNEL_ID", "C0123456789");
    getTokenMock.mockResolvedValue("xoxb-test");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        }),
      ),
    );

    const error = await sendSlackNotification(
      {
        runId: "wrun_limited",
        repository: "acme/api",
        status: "clean",
        completedAt: "2026-08-20T10:00:00.000Z",
      },
      "step_limited",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SlackDeliveryError);
    expect(error).toMatchObject({ retryable: true, retryAfterMs: 30_000 });
  });
});
