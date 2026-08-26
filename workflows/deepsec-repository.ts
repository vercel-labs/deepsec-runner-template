import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import {
  createHook,
  FatalError,
  getStepMetadata,
  getWorkflowMetadata,
  RetryableError,
  sleep,
} from "workflow";
import { getRepositoryConfig } from "@/config/repositories";
import type { RepositoryConfig } from "@/config/schema";
import { basicAuthorization } from "@/lib/basic-authorization";
import { getGitHubInstallationToken, publishGitHubIssue } from "@/lib/github";
import {
  deliveryMetadata,
  parseSandboxOutbox,
  type OutboxDeliveryMetadata,
} from "@/lib/outbox";
import { sandboxNameForRepository } from "@/lib/sandbox-identity";
import { SANDBOX_RUNNER_SOURCE } from "@/lib/sandbox-runner";
import {
  requireSlackConfiguration,
  sendSlackNotification,
  SlackConfigurationError,
  SlackDeliveryError,
  type SlackRunNotification,
} from "@/lib/slack";

type Trigger = {
  repoId: string;
};

const RUNNER_POLL_INTERVAL = "1m";
const RUNNER_POLL_INTERVAL_MS = 60_000;
const SANDBOX_STOP_MARGIN_MS = 120_000;
const MAX_SANDBOX_SESSIONS = 3;
const GITHUB_PLACEHOLDER = "sandbox-brokered-github";
const GATEWAY_PLACEHOLDER = "sandbox-brokered-gateway";

function escapeRe2(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function prepareSandbox(config: RepositoryConfig) {
  "use step";
  const githubToken =
    config.cloneAccess === "github-app"
      ? await getGitHubInstallationToken(config.repository, ["contents:read"])
      : null;
  // Workflow steps do not have the originating route Request, so they cannot
  // reliably read the runtime x-vercel-oidc-token header. Use a revocable,
  // budgeted Gateway key and keep it outside the Sandbox VM.
  const gatewayCredential = process.env.AI_GATEWAY_API_KEY;
  if (!gatewayCredential) {
    throw new Error(
      "AI Gateway authentication is not configured. Set AI_GATEWAY_API_KEY on the Vercel project.",
    );
  }

  const githubAuthorization = basicAuthorization(
    "x-access-token",
    GITHUB_PLACEHOLDER,
  );
  const [owner, repository] = config.repository.split("/");
  const githubRules = githubToken
    ? [
        {
          match: {
            method: ["GET", "POST"],
            path: {
              regex: `^/${escapeRe2(owner)}/${escapeRe2(repository)}(?:\\.git)?/(?:info/refs|git-upload-pack)$`,
            },
            headers: [
              {
                key: { exact: "authorization" },
                value: { exact: githubAuthorization },
              },
            ],
          },
          transform: [
            {
              headers: {
                authorization: basicAuthorization("x-access-token", githubToken),
              },
            },
          ],
        },
      ]
    : [];
  const networkPolicy: NetworkPolicy = {
    allow: {
      "github.com": githubRules,
      "ai-gateway.vercel.sh": [
        {
          match: {
            method: ["POST"],
            path: { startsWith: "/v1/" },
            headers: [
              {
                key: { exact: "authorization" },
                value: { exact: `Bearer ${GATEWAY_PLACEHOLDER}` },
              },
            ],
          },
          transform: [
            { headers: { authorization: `Bearer ${gatewayCredential}` } },
          ],
        },
      ],
      "registry.npmjs.org": [],
      "*.npmjs.org": [],
    },
  };
  const sandboxName = sandboxNameForRepository(config);
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.getOrCreate({
      name: sandboxName,
      runtime: "node24",
      persistent: true,
      timeout: config.sandbox.timeoutMs,
      resources: { vcpus: config.sandbox.vcpus },
      snapshotExpiration: config.sandbox.snapshotExpirationMs,
      keepLastSnapshots: { count: 1 },
      networkPolicy,
      env: {
        AI_GATEWAY_API_KEY: GATEWAY_PLACEHOLDER,
        ...(githubToken
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
              GIT_CONFIG_VALUE_0: `Authorization: ${githubAuthorization}`,
            }
          : {}),
        // deepsec uses this supported flag to disable Codex's nested bwrap
        // sandbox. The Vercel microVM and deny-by-default network policy remain
        // the outer isolation boundary.
        DEEPSEC_INSIDE_SANDBOX: "1",
        DEEPSEC_NO_UPDATE_CHECK: "1",
        CI: "1",
      },
      tags: { app: "deepsec-runner", repo: config.id },
    });
    // Named persistent Sandboxes retain the configuration they were created
    // with. Apply the current repo config on every resume as well as on create.
    await sandbox.update({
      persistent: true,
      resources: { vcpus: config.sandbox.vcpus },
      timeout: config.sandbox.timeoutMs,
      networkPolicy,
      tags: { app: "deepsec-runner", repo: config.id },
      snapshotExpiration: config.sandbox.snapshotExpirationMs,
      keepLastSnapshots: { count: 1 },
    });
  } catch {
    // The policy contains credential transforms. Never allow an SDK error to
    // reflect its request payload into durable Workflow state or Slack.
    throw new Error("Sandbox preparation failed");
  }
  // `Sandbox.mkDir` returns 400 when this directory already exists in a
  // resumed persistent filesystem. Use the idempotent POSIX form instead.
  const runnerDirectory = await sandbox.runCommand("mkdir", [
    "-p",
    "/vercel/sandbox/runner",
  ]);
  if (runnerDirectory.exitCode !== 0) {
    throw new Error("Could not prepare the Sandbox runner directory");
  }
  return sandbox;
}

async function configureSandbox(
  sandbox: Sandbox,
  config: RepositoryConfig,
  executionId: string,
) {
  "use step";
  await sandbox.writeFiles([
    { path: "/vercel/sandbox/runner/run.mjs", content: SANDBOX_RUNNER_SOURCE },
    {
      path: "/vercel/sandbox/runner/config.json",
      content: JSON.stringify(
        { ...config, _executionId: executionId },
        null,
        2,
      ),
    },
  ]);
}

async function resolveConfig(repoId: string) {
  "use step";
  const config = getRepositoryConfig(repoId);
  if (!config?.enabled) throw new Error(`Repository ${repoId} is missing or disabled`);
  return config;
}

async function stopSandbox(sandbox: Sandbox) {
  "use step";
  await sandbox.stop();
}

async function markPublished(sandbox: Sandbox, targetSha: string) {
  "use step";
  const source = `const fs=require('fs'),p='/vercel/sandbox/runner/state.json';let s={};try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch{};s.lastPublishedSha=${JSON.stringify(targetSha)};s.lastPublishedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(s,null,2)+'\\n')`;
  const result = await sandbox.runCommand("node", ["-e", source]);
  if (result.exitCode !== 0) throw new Error("Could not commit publication state");
}

async function readOutboxMetadata(
  sandbox: Sandbox,
  config: RepositoryConfig,
): Promise<OutboxDeliveryMetadata> {
  "use step";
  const content = await sandbox.readFileToBuffer({
    path: "/vercel/sandbox/runner/outbox.json",
  });
  return deliveryMetadata(parseSandboxOutbox(content, config));
}

async function readValidatedOutbox(
  sandbox: Sandbox,
  config: RepositoryConfig,
) {
  const content = await sandbox.readFileToBuffer({
    path: "/vercel/sandbox/runner/outbox.json",
  });
  return parseSandboxOutbox(content, config);
}

async function publish(
  config: RepositoryConfig,
  sandbox: Sandbox,
  runId: string,
  sandboxName: string,
) {
  "use step";
  const outbox = await readValidatedOutbox(sandbox, config);
  return publishGitHubIssue(config, outbox, runId, sandboxName);
}

async function notifySlack(
  config: RepositoryConfig,
  notification: SlackRunNotification,
  findingsSandbox?: Sandbox,
) {
  "use step";
  const { stepId } = getStepMetadata();
  try {
    let resolvedNotification = notification;
    if (notification.status === "findings" && !notification.issueUrl) {
      if (!findingsSandbox) {
        throw new SlackConfigurationError(
          "Slack-only findings require the completed Sandbox outbox",
        );
      }
      const outbox = await readValidatedOutbox(findingsSandbox, config);
      if (
        outbox.status !== "findings" ||
        outbox.targetSha !== notification.targetSha
      ) {
        throw new SlackConfigurationError(
          "Slack-only findings do not match the completed Sandbox outbox",
        );
      }
      resolvedNotification = { ...notification, summary: outbox.summary };
    }
    return await sendSlackNotification(
      {
        ...resolvedNotification,
        channelId: config.notifications.slackChannelId,
      },
      stepId,
    );
  } catch (error) {
    if (error instanceof SlackConfigurationError) {
      throw new FatalError(error.message);
    }
    if (error instanceof SlackDeliveryError) {
      if (error.retryable) {
        throw new RetryableError(
          error.message,
          error.retryAfterMs ? { retryAfter: error.retryAfterMs } : undefined,
        );
      }
      throw new FatalError(error.message);
    }
    throw error;
  }
}

async function validateRuntimeConfiguration(config: RepositoryConfig) {
  "use step";
  try {
    requireSlackConfiguration(config.notifications.slackChannelId);
  } catch (error) {
    if (error instanceof SlackConfigurationError) {
      throw new FatalError(error.message);
    }
    throw error;
  }
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new FatalError("AI_GATEWAY_API_KEY is required for Workflow runs");
  }
  if (
    (config.cloneAccess === "github-app" ||
      config.issuePublication === "required") &&
    !process.env.GITHUB_CONNECTOR
  ) {
    throw new FatalError("GITHUB_CONNECTOR is required for this repository");
  }
  if (
    config.issuePublication === "required" &&
    (process.env.DEEPSEC_MARKER_SECRET?.length ?? 0) < 32
  ) {
    throw new FatalError(
      "DEEPSEC_MARKER_SECRET must be at least 32 characters when GitHub issue publication is required",
    );
  }
}

async function currentTimestamp() {
  "use step";
  return new Date().toISOString();
}

export async function deepsecRepositoryWorkflow(trigger: Trigger) {
  "use workflow";
  const config = await resolveConfig(trigger.repoId);
  const runId = getWorkflowMetadata().workflowRunId;
  const sandboxName = sandboxNameForRepository(config);
  await validateRuntimeConfiguration(config);

  using repositoryLease = createHook({ token: `deepsec:${config.id}` });
  const conflict = await repositoryLease.getConflict();
  if (conflict) {
    const completedAt = await currentTimestamp();
    await notifySlack(config, {
      runId,
      repository: config.repository,
      status: "already-running",
      runMode: "incremental",
      activeRunId: conflict.runId,
      completedAt,
    });
    return {
      status: "already-running" as const,
      sandboxName,
      activeRunId: conflict.runId,
    };
  }

  let activeSandbox: Sandbox | undefined;
  let lastTargetSha: string | null = null;
  let lastIssueUrl: string | null = null;
  let completedResult:
    | {
        status: "clean" | "findings" | "no-changes";
        sandboxName: string;
        targetSha: string;
        issue: Awaited<ReturnType<typeof publish>>;
        sandboxSessions: number;
      }
    | undefined;
  let completedNotification: SlackRunNotification | undefined;

  try {
    for (let session = 1; session <= MAX_SANDBOX_SESSIONS; session += 1) {
      const executionId = `${runId}:${session}`;
      activeSandbox = await prepareSandbox(config);

      await configureSandbox(activeSandbox, config, executionId);
      const command = await activeSandbox.runCommand({
        cmd: "node",
        args: ["/vercel/sandbox/runner/run.mjs"],
        // Named Sandboxes created before this flag was introduced retain
        // their original environment, so also set it on every runner command.
        env: {
          DEEPSEC_INSIDE_SANDBOX: "1",
          AI_GATEWAY_API_KEY: GATEWAY_PLACEHOLDER,
          ...(config.cloneAccess === "github-app"
            ? {
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
                GIT_CONFIG_VALUE_0: `Authorization: ${basicAuthorization(
                  "x-access-token",
                  GITHUB_PLACEHOLDER,
                )}`,
              }
            : {}),
        },
        detached: true,
      });
      const pollCount = Math.max(
        1,
        Math.floor(
          (config.sandbox.timeoutMs - SANDBOX_STOP_MARGIN_MS) /
            RUNNER_POLL_INTERVAL_MS,
        ),
      );
      let exitCode: number | null = null;
      for (let poll = 0; poll < pollCount; poll += 1) {
        await sleep(RUNNER_POLL_INTERVAL);
        // Files inside the VM, including progress.json, are untrusted. Only
        // the control-plane command lifecycle may declare runner completion.
        const current = await activeSandbox.getCommand(command.cmdId);
        if (current.exitCode === null) continue;
        exitCode = current.exitCode;
        break;
      }

      if (exitCode === null) {
        // Stop just before the configured session deadline so its filesystem
        // is snapshotted, then resume the same named Sandbox. deepsec reclaims
        // the interrupted run records if a scan exceeds one session.
        await stopSandbox(activeSandbox);
        activeSandbox = undefined;
        continue;
      }
      if (exitCode !== 0) {
        throw new Error(`Sandbox runner exited with ${exitCode}`);
      }

      const outbox = await readOutboxMetadata(activeSandbox, config);
      const issue = await publish(config, activeSandbox, runId, sandboxName);
      lastTargetSha = outbox.targetSha;
      lastIssueUrl = issue.issueUrl ?? null;
      completedResult = {
        status: outbox.status,
        sandboxName,
        targetSha: outbox.targetSha,
        issue,
        sandboxSessions: session,
      };
      completedNotification = {
        runId,
        repository: config.repository,
        status: outbox.status,
        runMode: outbox.mode,
        targetSha: outbox.targetSha,
        filesAnalyzed: outbox.filesAnalyzed,
        findingsCount: outbox.findingsCount,
        findingsBySeverity: outbox.findingsBySeverity,
        issueUrl: issue.issueUrl,
        completedAt: outbox.completedAt,
      };
      break;
    }

    if (!completedResult || !completedNotification || !activeSandbox) {
      throw new Error(
        `deepsec did not complete after ${MAX_SANDBOX_SESSIONS} Sandbox sessions`,
      );
    }

    // Publication is complete only after every required external delivery has
    // succeeded. Leaving lastPublishedSha untouched makes a later run replay
    // the durable outbox after an exhausted Slack retry.
    await notifySlack(config, completedNotification, activeSandbox);
    await markPublished(activeSandbox, completedResult.targetSha);
  } catch (error) {
    const completedAt = await currentTimestamp();
    const message = error instanceof Error ? error.message : String(error);
    const failureStatus = message.includes("did not complete after")
      ? "timed-out"
      : "failed";
    try {
      await notifySlack(config, {
        runId,
        repository: config.repository,
        status: failureStatus,
        runMode: "incremental",
        targetSha: lastTargetSha,
        issueUrl: lastIssueUrl,
        errorMessage:
          failureStatus === "timed-out"
            ? "deepsec exceeded the configured Sandbox session limit. Review the private Workflow and Sandbox logs."
            : "deepsec failed. Review the private Workflow and Sandbox logs.",
        completedAt,
      });
    } catch (notificationError) {
      void notificationError;
      throw new Error("deepsec run failed and its Slack notification also failed");
    }
    throw new Error(
      failureStatus === "timed-out"
        ? "deepsec did not complete within the Sandbox session limit"
        : "deepsec run failed; inspect the failed private Workflow step",
    );
  } finally {
    if (activeSandbox) {
      await stopSandbox(activeSandbox);
    }
  }

  return completedResult;
}
