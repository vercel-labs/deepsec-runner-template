import { start } from "workflow/api";
import { deepsecRepositoryWorkflow } from "@workflows/deepsec-repository";
import { getRepositoryConfig } from "@/config/repositories";
import { isBearerAuthorized } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ repoId: string }> }) {
  if (!isBearerAuthorized(request, process.env.CRON_SECRET)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { repoId } = await context.params;
  const config = getRepositoryConfig(repoId);
  if (!config?.enabled) return Response.json({ error: "Repository not found or disabled" }, { status: 404 });
  const run = await start(deepsecRepositoryWorkflow, [{ repoId }]);
  return Response.json({ accepted: true, repoId, runId: run.runId }, { status: 202 });
}
