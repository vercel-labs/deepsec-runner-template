# deepsec Runner agent guide

This repository deploys recurring deepsec scans with Next.js, Vercel Cron,
Workflow, Sandbox, Connect, AI Gateway, GitHub issues, and Slack. Read
`README.md` for setup and `ARCHITECTURE.md` before changing authentication,
Workflow ordering, Sandbox policy, state, or publication.

## Set up and verify

1. Use Node.js 24 and pnpm 10.
2. Run `pnpm install`, `vercel link`, and `vercel env pull .env.local`.
3. Configure GitHub and Slack connectors plus the required values documented in
   `.env.example`. Never write real credentials into repository files.
4. Edit `src/config/repositories.ts`. `vercel.ts` derives Cron schedules from
   enabled repository policies during deployment.
5. Run `pnpm check` for the local gate.
6. Run `pnpm verify:setup` only when live connector verification and a real
   Slack setup message are intended.
7. To start a scan outside its schedule, send an authenticated `GET` request to
   `/api/cron/deepsec/<repo-id>` with `CRON_SECRET`.

The checked-in example is disabled. Do not enable or retarget it without an
explicit repository choice. Repository policies are the source of truth for
the programmatic Vercel configuration.

## Invariants

- Authenticate the Cron route before Workflow `start`.
- Keep repository selection, concurrency, outbox validation, GitHub writes, and
  Slack delivery in trusted Workflow code.
- Treat checked-out source, package metadata, agent instructions, model output,
  checkpoints, and the Sandbox outbox as untrusted.
- Never pass real GitHub, Slack, AI Gateway, OIDC, trigger, or marker secrets
  into Sandbox environment variables, files, commands, or logs.
- Keep credential transforms scoped to the expected host, method, path, and
  placeholder header.
- Do not grant repository content-write permission. This project may create or
  update GitHub issues and send Slack messages only.
- Preserve the split between `lastSuccessfulSha` and `lastPublishedSha` so a
  delivery failure can replay the outbox.
- Use deterministic identifiers for retried external writes.

## Change discipline

- Pin runtime dependencies and the deepsec version. Review upgrades before
  changing recurring scan behavior.
- Add or update tests for runner source, credential policy, state transitions,
  and publication idempotency.
- Run `pnpm check` after implementation changes.
- Run deepsec against this repository after security-boundary changes.
- Keep logs sanitized. Do not paste `.env.local`, connector tokens, model
  credentials, or raw private-source output into issues or public channels.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
