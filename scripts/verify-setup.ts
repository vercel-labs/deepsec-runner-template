import { loadEnvConfig } from "@next/env";
import { repositories } from "../src/config/repositories";
import { getGitHubInstallationToken } from "../src/lib/github";
import { sendSlackNotification } from "../src/lib/slack";

function requireEnvironment(name: string, minimumLength = 1): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength) {
    throw new Error(
      `${name} is required${minimumLength > 1 ? ` and must be at least ${minimumLength} characters` : ""}`,
    );
  }
  return value;
}

async function main() {
  loadEnvConfig(process.cwd());
  const enabled = repositories.filter((repository) => repository.enabled);
  if (enabled.length === 0) {
    throw new Error("No repositories are enabled. Configure src/config/repositories.ts.");
  }

  if (
    enabled.some(
      (repository) =>
        repository.cloneAccess === "github-app" ||
        repository.issuePublication === "required",
    )
  ) {
    requireEnvironment("GITHUB_CONNECTOR");
  }
  requireEnvironment("SLACK_CONNECTOR");
  if (enabled.some((repository) => !repository.notifications.slackChannelId)) {
    requireEnvironment("SLACK_CHANNEL_ID");
  }
  requireEnvironment("AI_GATEWAY_API_KEY");
  requireEnvironment("CRON_SECRET", 32);
  if (enabled.some((repository) => repository.issuePublication === "required")) {
    requireEnvironment("DEEPSEC_MARKER_SECRET", 32);
  }

  for (const repository of enabled) {
    const permissions: Array<"contents:read" | "issues:write"> = [];
    if (repository.cloneAccess === "github-app") permissions.push("contents:read");
    if (repository.issuePublication === "required") permissions.push("issues:write");
    if (permissions.length > 0) {
      await getGitHubInstallationToken(repository.repository, permissions);
    }
  }

  const channels = new Set(
    enabled.map(
      (repository) =>
        repository.notifications.slackChannelId || process.env.SLACK_CHANNEL_ID!,
    ),
  );
  const checkedAt = new Date().toISOString();
  for (const channelId of channels) {
    await sendSlackNotification(
      {
        runId: "setup-verification",
        repository: `${enabled.length} configured repositor${enabled.length === 1 ? "y" : "ies"}`,
        status: "setup-verified",
        channelId,
        completedAt: checkedAt,
      },
      `setup-verification:${channelId}:${checkedAt}`,
    );
  }

  console.log(
    `Setup verified for ${enabled.length} enabled repositor${enabled.length === 1 ? "y" : "ies"} and ${channels.size} Slack channel${channels.size === 1 ? "" : "s"}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
