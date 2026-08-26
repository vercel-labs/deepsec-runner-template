# deepsec Runner

Run recurring [deepsec](https://deepsec.sh/docs/getting-started) security reviews across GitHub repositories. The runner checks out untrusted code in Vercel Sandbox, keeps long scans durable with Vercel Workflow, opens deduplicated GitHub issues, and reports every terminal outcome to Slack.

The runner never modifies a scanned repository. Its only external writes are GitHub issues and Slack messages.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fdeepsec-runner-template&project-name=deepsec-runner&repository-name=deepsec-runner&env=GITHUB_CONNECTOR%2CSLACK_CONNECTOR%2CSLACK_CHANNEL_ID%2CAI_GATEWAY_API_KEY%2CDEEPSEC_MARKER_SECRET%2CCRON_SECRET&envDefaults=%7B%22GITHUB_CONNECTOR%22%3A%22github%2Fdeepsec-scanner%22%2C%22SLACK_CONNECTOR%22%3A%22slack%2Fdeepsec-notifier%22%7D&envDescription=Create+and+attach+the+GitHub+and+Slack+Vercel+Connect+connectors%2C+then+enter+their+locators%2C+a+Slack+channel+ID%2C+and+the+required+secrets.&envLink=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fdeepsec-runner-template%234-configure-environment-values)

The deploy flow prompts for every required runtime value and prefills only the non-secret connector locators. It cannot create Vercel Connect connectors: after Vercel creates the project, create the GitHub and Slack connectors described below and attach both to the project’s Production environment before enabling a repository policy. Update `GITHUB_CONNECTOR` or `SLACK_CONNECTOR` if you choose locators other than the prefilled values.

## How it works

1. Vercel Cron starts a Workflow and returns immediately. An operator can call the same authenticated route on demand.
2. Workflow validates configuration and claims one deterministic lease per repository. Overlapping runs are coalesced before Sandbox compute starts.
3. Vercel Connect grants short-lived GitHub access for the configured repository.
4. A named persistent Sandbox clones or fetches the repository and runs the pinned deepsec version.
5. The Sandbox writes a structured outbox. It cannot create issues or send Slack messages.
6. Trusted Workflow steps validate and consume the outbox without returning the raw findings report into durable Workflow state, create or update a GitHub issue, and notify Slack.
7. Delivery is committed only after all required external writes succeed. Failed delivery is replayed on the next run without duplicating issues.

See [ARCHITECTURE.md](ARCHITECTURE.md) for trust boundaries, credentials, state, failure behavior, and the purpose of every Vercel product used.

## Prerequisites

- Node.js 24 and pnpm 10
- The [Vercel CLI](https://vercel.com/docs/cli), authenticated to the target team
- A Vercel project with Workflow, Sandbox, AI Gateway, and Connect available
- Permission to install a GitHub App on the repositories to scan
- Permission to install a Slack app and invite it to a channel
- An AI Gateway key with an appropriate project budget

The checked-in repository policy is disabled. A fresh clone cannot start a scan or consume scan compute until you configure and enable a repository.

## Set up the runner

### 1. Install and link the project

```bash
pnpm install
vercel link
```

Create a new Vercel project when prompted, or link an existing one. Use the same project and environment for both Connect attachments.

### 2. Create the GitHub connection

In the Vercel team dashboard, open **Connect** and create a GitHub connector such as `github/deepsec-scanner`.

Grant these maximum repository permissions:

- Contents: read
- Issues: read and write
- Metadata: read

Install the managed GitHub App with **Only select repositories** and select every repository this deployment may scan or write issues to. Attach the connector to the Vercel project and its Production environment.

The connector is the reusable authorization boundary. Each run narrows access again to one repository and requests either `contents:read` or `issues:write`. The project never stores a GitHub App private key.

### 3. Create and verify the Slack connection

Create a Slack connector such as `slack/deepsec-notifier`, grant the managed app the `chat:write` bot scope, install it, and invite it to the destination channel. Attach the connector to the same Vercel project and environment.

Use the Slack channel ID, such as `C0123456789`, rather than its display name. `pnpm verify:setup` sends a real setup-verification message. A successful message confirms the connector, scope, app installation, and channel membership.

### 4. Configure environment values

Add the following values in Vercel Project Settings. Apply them to Production and to Development if you will run the complete flow locally.

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `GITHUB_CONNECTOR` | Required for authenticated clone or GitHub issues | Non-secret Connect locator, for example `github/deepsec-scanner` |
| `SLACK_CONNECTOR` | Required | Non-secret Connect locator, for example `slack/deepsec-notifier` |
| `SLACK_CHANNEL_ID` | Required unless every repository overrides it | Default terminal-notification channel |
| `AI_GATEWAY_API_KEY` | Required | Revocable Gateway credential injected only at Sandbox egress |
| `DEEPSEC_MARKER_SECRET` | Required for GitHub issue publication | HMAC secret for unguessable issue deduplication markers |
| `CRON_SECRET` | Required | Authenticates Vercel Cron requests |

Generate independent secrets of at least 32 characters:

```bash
openssl rand -hex 32 # CRON_SECRET
openssl rand -hex 32 # DEEPSEC_MARKER_SECRET
```

Set a project or key budget in [AI Gateway](https://vercel.com/docs/ai-gateway) before enabling schedules. The Gateway key is required because deployed OIDC is attached to a Vercel Function request, while the scan continues asynchronously in Workflow steps. The key stays in the trusted Workflow and Sandbox control plane; the microVM receives only a placeholder.

For local verification, pull the Development environment after configuring it:

```bash
vercel env pull .env.local
```

Never commit `.env.local`.

### 5. Add a repository policy

Edit [src/config/repositories.ts](src/config/repositories.ts). Start with one repository and keep the pinned deepsec version unless you have tested an upgrade.

```ts
{
  id: "payments-api",
  enabled: true,
  repository: "acme/payments-api",
  defaultBranch: "main",
  cloneAccess: "github-app",
  issuePublication: "required",
  frequency: "0 7 * * 1",
  agent: "codex",
  model: "gpt-5.5",
  thinkingLevel: "high",
  batchSize: 2,
  priorityPaths: ["src/auth/", "src/api/", "src/billing/"],
  ignorePaths: ["**/fixtures/**", "**/dist/**"],
  promptAppend: "Prioritize authorization and payment state transitions.",
  context:
    "A multi-tenant payments API. Treat requests and webhooks as attacker-controlled.",
  deepsecVersion: "2.3.7",
  notifications: {
    // Optional; falls back to SLACK_CHANNEL_ID.
    slackChannelId: "C0123456789",
  },
  sandbox: {
    vcpus: 4,
    timeoutMs: 2_700_000,
    snapshotExpirationMs: 2_592_000_000,
  },
}
```

Important policy choices:

| Field | Guidance |
| --- | --- |
| `id` | Stable lowercase identifier used by routes, Workflow leases, and persistent state |
| `cloneAccess` | Use `github-app` for private source; use `public` only for anonymous public clones |
| `issuePublication` | Use `required` for GitHub issues plus Slack; use `slack-only` when findings must not be written to GitHub |
| `frequency` | Five-field UTC Vercel Cron expression |
| `context` | Describe architecture, assets, attacker-controlled inputs, and security invariants |
| `priorityPaths` | Put authentication, authorization, billing, parsers, and deployment boundaries first |
| `ignorePaths` | Exclude generated or vendored output narrowly; broad exclusions reduce security coverage |
| `batchSize` | Smaller batches isolate slow investigations; larger batches reduce overhead |
| `sandbox.timeoutMs` | One Sandbox session, not the whole Workflow; keep it within the Vercel plan limit |

The root `vercel.ts` reads this registry and derives one Cron job for each enabled policy during deployment. No generated schedule file needs to be committed. In a Git-connected project, committing a policy change is enough for the next deployment to receive the matching configuration.

### 6. Verify before deployment

```bash
pnpm check
pnpm verify:setup
```

`pnpm check` type-checks the programmatic Vercel configuration, runs tests, and compiles the production Next.js and Workflow bundles.

`pnpm verify:setup` performs live checks and has one external side effect. It:

- requires at least one enabled repository;
- validates required secrets and repository policies;
- requests the configured GitHub permissions for every enabled repository; and
- sends a real verification message to each configured Slack channel.

It does not create GitHub issues, change repository contents, or start a Sandbox.

### 7. Deploy and run the first scan

For a Git-connected project, push the policy change to a branch and review its Preview Deployment. Cron schedules are applied only to Production Deployments. Merge the change into the configured production branch, usually `main`, and Vercel will evaluate `vercel.ts`, build the application, and update the production schedules.

For a CLI-managed project, deploy explicitly:

```bash
vercel deploy --prod
```

Start the first complete incremental scan by calling the deployed Cron route with the same secret Vercel Cron uses:

```bash
curl --fail-with-body \
  --header "Authorization: Bearer $CRON_SECRET" \
  https://your-project.vercel.app/api/cron/deepsec/payments-api
```

The route accepts only configured, enabled repository IDs and returns the Workflow run ID with `202 Accepted`. Keep `CRON_SECRET` private: an authenticated request can start paid Sandbox and model work.

Confirm the Workflow reaches a terminal state, Slack receives the result, and a findings run creates a GitHub issue. The vulnerable integration fixture is described in [docs/testing-vulnerable-lab.md](docs/testing-vulnerable-lab.md).

## Operating the runner

### Outcomes

| Outcome | Meaning | GitHub | Slack |
| --- | --- | --- | --- |
| `clean` | All selected files completed with no net-new findings | No issue | Required notification |
| `findings` | deepsec produced source-backed findings | Creates or updates an issue when required | Counts, severities, and issue link or bounded Slack-only report |
| `no-changes` | The target commit equals the successful incremental baseline | No issue | Required notification |
| `failed` | Configuration, cloning, credentials, agent, quota, validation, publication, or analysis failed | No new issue unless publication had already succeeded | Required failure notification when Slack is reachable |
| `timed-out` | Three Sandbox sessions were insufficient | No incomplete findings issue | Required timeout notification |
| `already-running` | Another Workflow owns the repository lease | No issue | Active Workflow run ID |

Transient Slack failures retry and honor `Retry-After`. Retries use a deterministic Slack `client_msg_id`. GitHub retries use an HMAC-protected marker and reopen a matching closed issue. A pending outbox is replayed until both required publication and terminal notification succeed.

### Incremental state and recovery

The first successful incremental run analyzes all tracked, non-ignored files. Later runs select added, modified, renamed, and copied files between `lastSuccessfulSha` and the target commit.

One named persistent Sandbox is used per repository identity. It stores the checkout, installed deepsec package, file records, outbox, checkpoint, and delivery state. The Workflow stops two minutes before the configured session deadline and can resume the same Sandbox for up to three sessions. Completed files are not repeated after rollover.

Workflow owns concurrency; no lock file is trusted inside the Sandbox. The deterministic lease token is `deepsec:<repository-id>` and is released automatically when the Workflow ends.

Sandbox progress files are telemetry only. Workflow waits for the Sandbox control-plane command to exit successfully before it reads an outbox. If an incremental outbox is still unpublished, it is replayed before any newer commit can overwrite it.

### Fleet size and Vercel plans

Vercel supports 100 Cron jobs per project, and this template derives one Cron job per enabled repository. For more than 100 scheduled repositories, deploy multiple runner projects and divide the static registry between them. Repository IDs and Sandbox state are project-local.

| Plan | Minimum Cron interval | Scheduling precision | Sandbox session | Sandbox compute |
| --- | --- | --- | --- | --- |
| Hobby | Once per day | Within the configured hour | Up to 45 minutes | Up to 4 vCPUs |
| Pro | Once per minute | Within the configured minute | Up to 24 hours | Up to 8 vCPUs |
| Enterprise | Once per minute | Within the configured minute | Up to 24 hours | Up to 32 vCPUs; this schema currently permits 8 |

The default policy uses 4 vCPUs and a 45-minute session so it can run on Hobby. Hourly schedules require Pro or Enterprise. Check the current [Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) and [Sandbox limits](https://vercel.com/sandbox) before changing resource settings.

### Observability

Use Vercel’s Workflow and Sandbox views for run state, retries, command lifecycle, duration, and resource usage. Logs are operational diagnostics, not the finding system of record. The Workflow retains bounded counts and commit metadata, not the raw findings report. Do not forward raw Sandbox logs to public destinations: model and tool output may include repository source or security evidence.

For repositories that publish GitHub issues, Slack receives counts, severities, and the issue link but not the findings body. `slack-only` is an explicit policy choice that sends a bounded findings report to the configured Slack channel; restrict that channel to the intended security audience.

GitHub and Slack are the only result destinations in this template. No Postgres database or analytics store is required. See [ARCHITECTURE.md](ARCHITECTURE.md#state-and-recovery) for the consequences of that choice.

## Troubleshooting

### `pnpm verify:setup` cannot request a connector token

Confirm the connector is attached to the same Vercel project and Development environment, then run `vercel link` and `vercel env pull .env.local` again. For a private repository, confirm it is selected in the GitHub App installation.

### Slack returns `not_in_channel` or `channel_not_found`

Invite the managed Slack app to the configured channel and verify that you used the channel ID, not its name. Run `pnpm verify:setup` again; success means Slack accepted a real message.

### AI Gateway authentication fails

Set `AI_GATEWAY_API_KEY` in the Vercel environment used by the deployment and in Development for local runs. Runtime OIDC alone is not a supported fallback for the asynchronous Workflow. Verify the key is active, has available budget, and belongs to the intended team or project.

### A private repository cannot be cloned

Keep `cloneAccess: "github-app"`, select the repository in the GitHub App installation, and confirm the connector grants Contents read. The Sandbox sends only a placeholder credential; the firewall injects the short-lived repository token on the configured repository’s Git smart-HTTP paths.

### Findings do not create an issue

Confirm `issuePublication: "required"`, Issues write permission, repository selection, and a `DEEPSEC_MARKER_SECRET` of at least 32 characters. Repeated runs at the same target commit update and reopen the same runner issue.

### A scan times out

Reduce the file scope or batch size, add vCPUs within the plan limit, or increase `sandbox.timeoutMs`. A run can use three Sandbox sessions; a later Workflow can resume its persisted checkpoint if all three are exhausted.

### A schedule change is missing

Confirm the policy is enabled, its change reached the configured production branch, and the Production Deployment succeeded. Preview Deployments do not activate Cron schedules. Vercel evaluates `vercel.ts` during deployment, and Cron expressions are UTC. Hobby expressions that run more than once per day fail deployment.

## Development commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run Next.js and Workflow locally |
| `pnpm verify:setup` | Verify credentials, repository access, policy configuration, and real Slack delivery |
| `pnpm check` | Type-check, test, and build |

## Security notes

- Treat repositories, dependency metadata, package scripts, agent instructions, model output, and the Sandbox outbox as untrusted.
- Never place real GitHub or AI credentials in Sandbox environment variables, files, command arguments, or logs.
- Keep repository selection and every external write in trusted Workflow steps.
- GitHub issues inherit repository visibility. Use private vulnerability reporting or an internal system for embargoed findings.
- Rotate the Gateway, trigger, and marker secrets through Vercel environment controls. Rotating the marker secret starts a new issue-deduplication namespace.
- Keep AI Gateway budgets and Vercel usage alerts enabled.
- Local, unsandboxed deepsec scans can read local files such as `.env.local`; use sanitized environments or deepsec Sandbox mode for repositories you do not trust at that level.

## Resources

- [Architecture](ARCHITECTURE.md)
- [deepsec documentation](https://deepsec.sh/docs/getting-started)
- [Vercel Workflow](https://vercel.com/docs/workflow)
- [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)
- [Vercel Connect](https://vercel.com/kb/guide/vercel-connect)
- [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
