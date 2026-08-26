import { getToken } from "@vercel/connect";
import { createHash } from "node:crypto";

type TerminalRunStatus =
  | "clean"
  | "findings"
  | "no-changes"
  | "failed"
  | "timed-out"
  | "already-running"
  | "setup-verified";

export type SlackRunNotification = {
  runId: string;
  repository: string;
  status: TerminalRunStatus;
  runMode?: "incremental";
  channelId?: string;
  targetSha?: string | null;
  filesAnalyzed?: number | null;
  findingsCount?: number | null;
  findingsBySeverity?: Record<string, number>;
  summary?: string | null;
  issueUrl?: string | null;
  activeRunId?: string | null;
  errorMessage?: string | null;
  completedAt: string;
};

type SlackResponse = {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
};

export class SlackConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackConfigurationError";
  }
}

export class SlackDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SlackDeliveryError";
  }
}

const TRANSIENT_SLACK_ERRORS = new Set([
  "fatal_error",
  "internal_error",
  "rate_limited",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
  "team_added_to_org",
]);

const STATUS_COPY: Record<SlackRunNotification["status"], { emoji: string; title: string }> = {
  clean: { emoji: "✅", title: "deepsec scan clean" },
  findings: { emoji: "🚨", title: "deepsec findings require review" },
  "no-changes": { emoji: "⏭️", title: "deepsec scan skipped — no changes" },
  failed: { emoji: "❌", title: "deepsec scan failed" },
  "timed-out": { emoji: "⏱️", title: "deepsec scan timed out" },
  "already-running": { emoji: "↪️", title: "deepsec trigger coalesced" },
  "setup-verified": { emoji: "✅", title: "deepsec Slack setup verified" },
};

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function severityText(counts: Record<string, number> | undefined): string | null {
  const entries = Object.entries(counts ?? {}).filter(([, count]) => count > 0);
  if (entries.length === 0) return null;
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([severity, count]) =>
        `${count} ${escapeSlack(severity.toLowerCase())}`,
    )
    .join(" · ");
}

function summaryChunks(summary: string | null | undefined): string[] {
  if (!summary?.trim()) return [];
  const escaped = escapeSlack(summary.trim());
  const chunks: string[] = [];
  let remaining = escaped;
  while (remaining.length > 0 && chunks.length < 8) {
    if (remaining.length <= 2_700) {
      chunks.push(remaining);
      remaining = "";
      break;
    }
    const candidate = remaining.slice(0, 2_700);
    const newline = candidate.lastIndexOf("\n");
    const splitAt = newline > 1_800 ? newline : 2_700;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) {
    chunks[chunks.length - 1] = `${chunks.at(-1)}\n\n_Findings summary truncated for Slack._`;
  }
  return chunks;
}

export function buildSlackMessage(notification: SlackRunNotification) {
  const copy = STATUS_COPY[notification.status];
  const fields = [
    {
      type: "mrkdwn",
      text: `*Repository*\n${escapeSlack(notification.repository)}`,
    },
    notification.runMode
      ? { type: "mrkdwn", text: `*Run mode*\n${notification.runMode}` }
      : null,
    notification.targetSha
      ? { type: "mrkdwn", text: `*Commit*\n\`${notification.targetSha.slice(0, 12)}\`` }
      : null,
    typeof notification.filesAnalyzed === "number"
      ? { type: "mrkdwn", text: `*Files analyzed*\n${notification.filesAnalyzed}` }
      : null,
    typeof notification.findingsCount === "number"
      ? { type: "mrkdwn", text: `*Findings*\n${notification.findingsCount}` }
      : null,
  ].filter((field): field is { type: string; text: string } => Boolean(field));
  const details = severityText(notification.findingsBySeverity);
  const links = [
    notification.issueUrl ? `<${notification.issueUrl}|Open GitHub issue>` : null,
  ].filter(Boolean);
  const context = [
    `Run \`${notification.runId}\``,
    new Date(notification.completedAt).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }) + " UTC",
  ].join(" · ");

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: `${copy.emoji} ${copy.title}`, emoji: true },
    },
    { type: "section", fields },
  ];
  if (details) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Severity*\n${details}` } });
  }
  if (notification.status === "findings" && !notification.issueUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*GitHub issue*\nNot created — this repository uses Slack-only publication.",
      },
    });
  }
  // Detailed findings belong in the configured GitHub issue. Only a policy
  // that explicitly opts into Slack-only publication sends the bounded report
  // to Slack, where channel membership may be broader than repository access.
  const findingsSummary =
    notification.status === "findings" && !notification.issueUrl
      ? summaryChunks(notification.summary)
      : [];
  findingsSummary.forEach((chunk, index) => {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${index === 0 ? "*Findings report*\n" : ""}${chunk}`,
      },
    });
  });
  if (notification.errorMessage) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Failure*\n${escapeSlack(notification.errorMessage).slice(0, 1200)}`,
      },
    });
  }
  if (notification.activeRunId) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `Active run: \`${notification.activeRunId}\`` },
    });
  }
  if (links.length > 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: links.join("  ·  ") } });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: context }] });

  return {
    text: `${copy.emoji} ${copy.title}: ${notification.repository}`,
    blocks,
  };
}

export function requireSlackConfiguration(channelId?: string): {
  connector: string;
  channel: string;
} {
  const connector = process.env.SLACK_CONNECTOR;
  const channel = channelId || process.env.SLACK_CHANNEL_ID;
  if (!connector || !channel) {
    throw new SlackConfigurationError(
      "Slack is required. Configure SLACK_CONNECTOR and either SLACK_CHANNEL_ID or notifications.slackChannelId.",
    );
  }
  return { connector, channel };
}

function slackClientMessageId(deliveryId: string): string {
  const hash = createHash("sha256").update(deliveryId).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export async function sendSlackNotification(
  notification: SlackRunNotification,
  deliveryId: string,
): Promise<{
  sent: boolean;
  timestamp?: string;
}> {
  const { connector, channel } = requireSlackConfiguration(notification.channelId);

  let token: string;
  try {
    token = await getToken(
      connector,
      { subject: { type: "app" }, scopes: ["chat:write"] },
      process.env.VERCEL_TOKEN
        ? { vercelToken: process.env.VERCEL_TOKEN }
        : undefined,
    );
  } catch {
    throw new SlackDeliveryError("Could not obtain a Slack connector token", true);
  }

  let response: Response;
  try {
    response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        client_msg_id: slackClientMessageId(deliveryId),
        ...buildSlackMessage(notification),
      }),
    });
  } catch {
    throw new SlackDeliveryError("Slack notification request failed", true);
  }
  if (response.status === 429) {
    const retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") ?? "1", 10);
    throw new SlackDeliveryError(
      "Slack rate-limited the notification",
      true,
      Math.max(1, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 1) * 1_000,
    );
  }

  let body: SlackResponse;
  try {
    body = (await response.json()) as SlackResponse;
  } catch {
    throw new SlackDeliveryError(
      `Slack returned an unreadable response (${response.status})`,
      true,
    );
  }
  if (!response.ok || !body.ok) {
    const code = body.error ?? `http_${response.status}`;
    throw new SlackDeliveryError(
      `Slack rejected the notification: ${code}`,
      response.status >= 500 || TRANSIENT_SLACK_ERRORS.has(code),
    );
  }
  return { sent: true, timestamp: body.ts };
}
