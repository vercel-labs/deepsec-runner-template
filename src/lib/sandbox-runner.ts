// Written into each persistent Sandbox. It owns the baseline SHA and only
// advances it after every file in the target-SHA checkpoint is analyzed.
export const SANDBOX_RUNNER_SOURCE = String.raw`
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/vercel/sandbox";
const REPO = path.join(ROOT, "repo");
const WORK = path.join(ROOT, ".deepsec");
const RUNNER = path.join(ROOT, "runner");
const cfg = JSON.parse(fs.readFileSync(path.join(RUNNER, "config.json"), "utf8"));
const statePath = path.join(RUNNER, "state.json");
const outboxPath = path.join(RUNNER, "outbox.json");
const progressPath = path.join(RUNNER, "progress.json");
const checkpointPath = path.join(RUNNER, "checkpoint.json");
const startedAt = new Date().toISOString();

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }
function progress(stage, details = {}) {
  const value = { executionId: cfg._executionId, stage, updatedAt: new Date().toISOString(), ...details };
  writeJson(progressPath, value);
  console.log("[deepsec-runner] " + stage + (details.message ? ": " + details.message : ""));
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: options.cwd ?? ROOT, env: process.env, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!options.accept?.includes(result.status ?? -1) && result.status !== 0) {
    throw new Error(cmd + " failed (" + result.status + "): " + (result.stderr || result.stdout || "no output"));
  }
  return (result.stdout ?? "").trim();
}

function safeJson(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function safeState() { return safeJson(statePath); }
function recordFor(file) {
  return safeJson(path.join(WORK, "data", cfg.id, "files", file + ".json"), null);
}
function processHistory(record) {
  return (record?.analysisHistory ?? []).filter((entry) => entry.phase !== "revalidate");
}
function configurationKey() {
  return JSON.stringify({ agent: cfg.agent, model: cfg.model, thinkingLevel: cfg.thinkingLevel, priorityPaths: cfg.priorityPaths, ignorePaths: cfg.ignorePaths, promptAppend: cfg.promptAppend, context: cfg.context, deepsecVersion: cfg.deepsecVersion });
}
function newCheckpoint(targetSha, files) {
  return {
    targetSha,
    files,
    configurationKey: configurationKey(),
    analysisCounts: Object.fromEntries(files.map((file) => [file, processHistory(recordFor(file)).length])),
    completedFiles: [],
    runIds: [],
    startedAt,
  };
}
function refreshCheckpoint(checkpoint) {
  const completed = new Set(checkpoint.completedFiles ?? []);
  const runIds = new Set(checkpoint.runIds ?? []);
  for (const file of checkpoint.files) {
    if (completed.has(file)) continue;
    const record = recordFor(file);
    const history = processHistory(record);
    const baseline = checkpoint.analysisCounts?.[file] ?? 0;
    const additions = history.slice(baseline);
    if (record?.status === "analyzed" && additions.length > 0) {
      completed.add(file);
      for (const entry of additions) if (entry.runId) runIds.add(entry.runId);
    }
  }
  return { ...checkpoint, completedFiles: [...completed], runIds: [...runIds], updatedAt: new Date().toISOString() };
}
function findingSummary(checkpoint) {
  const runIds = new Set(checkpoint.runIds ?? []);
  const findings = [];
  for (const file of checkpoint.files) {
    const record = recordFor(file);
    for (const finding of record?.findings ?? []) {
      if (finding.producedByRunId && runIds.has(finding.producedByRunId)) findings.push({ file, finding });
    }
  }
  if (findings.length === 0) return { findings, markdown: "deepsec completed without net-new findings." };
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, HIGH_BUG: 3, BUG: 4, LOW: 5 };
  findings.sort((a, b) => (rank[a.finding.severity] ?? 99) - (rank[b.finding.severity] ?? 99) || a.file.localeCompare(b.file));
  const lines = ["## deepsec found " + findings.length + " finding" + (findings.length === 1 ? "" : "s"), ""];
  for (const item of findings) {
    const finding = item.finding;
    const line = finding.lineNumbers?.[0] ? ":L" + finding.lineNumbers[0] : "";
    lines.push("### " + finding.severity + " · " + item.file + line, "", "**" + finding.title + "**", "", String(finding.description ?? "").slice(0, 1200), "", "**Recommendation:** " + String(finding.recommendation ?? "").slice(0, 800), "", "---", "");
  }
  return { findings, markdown: lines.join("\n") };
}
function analysisFailures(checkpoint) {
  const failures = [];
  for (const file of checkpoint.files) {
    const history = processHistory(recordFor(file));
    const baseline = checkpoint.analysisCounts?.[file] ?? 0;
    for (const entry of history.slice(baseline)) {
      const refusal = entry?.refusal;
      if (!refusal?.refused && !(refusal?.skipped?.length > 0)) continue;
      const reason = refusal.reason || refusal.skipped?.map((item) => item.reason).join("; ") || "analysis was refused or skipped";
      failures.push(file + ": " + reason);
    }
  }
  return failures;
}
function finalizeCheckpoint(checkpoint, targetSha, baseSha, files) {
  const failures = analysisFailures(checkpoint);
  if (failures.length > 0) {
    throw new Error("deepsec did not complete a trustworthy analysis: " + failures.join(" | "));
  }
  const result = findingSummary(checkpoint);
  const hasFindings = result.findings.length > 0;
  const findingsBySeverity = {};
  for (const item of result.findings) findingsBySeverity[item.finding.severity] = (findingsBySeverity[item.finding.severity] ?? 0) + 1;
  writeJson(outboxPath, { mode: "incremental", status: hasFindings ? "findings" : "clean", repository: cfg.repository, branch: cfg.defaultBranch, baseSha, targetSha, files, findingsCount: result.findings.length, findingsBySeverity, summary: result.markdown, startedAt: checkpoint.startedAt ?? startedAt, completedAt: new Date().toISOString() });
  writeJson(statePath, { ...safeState(), lastSuccessfulSha: targetSha, lastSuccessfulAt: new Date().toISOString() });
  try { fs.unlinkSync(checkpointPath); } catch {}
  progress("complete", { status: hasFindings ? "findings" : "clean", targetSha, findings: result.findings.length });
}

async function main() {
  fs.mkdirSync(RUNNER, { recursive: true });
  if (!fs.existsSync(path.join(REPO, ".git"))) {
    progress("cloning", { message: cfg.repository });
    run("git", ["clone", "--no-tags", "https://github.com/" + cfg.repository + ".git", REPO]);
  }
  const origin = run("git", ["remote", "get-url", "origin"], { cwd: REPO, capture: true });
  const remoteRepository = origin
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (remoteRepository !== cfg.repository.toLowerCase()) {
    throw new Error("Persistent Sandbox repository mismatch: expected " + cfg.repository + " but found " + origin + ". Use a new repository id or replace the stale Sandbox.");
  }
  progress("fetching", { message: cfg.defaultBranch });
  run("git", ["fetch", "--prune", "origin", cfg.defaultBranch], { cwd: REPO });
  const targetSha = run("git", ["rev-parse", "origin/" + cfg.defaultBranch], { cwd: REPO, capture: true });
  run("git", ["reset", "--hard", targetSha], { cwd: REPO });

  const state = safeState();
  let previousOutbox = null;
  try { previousOutbox = JSON.parse(fs.readFileSync(outboxPath, "utf8")); } catch {}
  if (
    previousOutbox?.mode === "incremental" &&
    previousOutbox?.targetSha === state.lastSuccessfulSha &&
    state.lastPublishedSha !== previousOutbox.targetSha
  ) {
    // Delivery is a hard barrier. Replay the previous incremental outbox even
    // if the remote branch has advanced; otherwise a newer analysis could
    // overwrite findings that GitHub or Slack has not accepted yet.
    progress("complete", { status: "pending-delivery", targetSha: previousOutbox.targetSha });
    return;
  }
  const baselineCheck = state.lastSuccessfulSha
    ? spawnSync("git", ["cat-file", "-e", state.lastSuccessfulSha + "^{commit}"], { cwd: REPO, stdio: "ignore" })
    : null;
  const baseIsValid = Boolean(state.lastSuccessfulSha && baselineCheck?.status === 0);
  let files;
  let baseSha = baseIsValid ? state.lastSuccessfulSha : null;
  if (baseSha === targetSha) files = [];
  else if (baseSha) files = run("git", ["diff", "--name-only", "--diff-filter=AMRC", baseSha + ".." + targetSha], { cwd: REPO, capture: true }).split("\n").filter(Boolean);
  else files = run("git", ["ls-files"], { cwd: REPO, capture: true }).split("\n").filter(Boolean);
  if (files.length === 0) {
    writeJson(outboxPath, { mode: "incremental", status: "no-changes", repository: cfg.repository, branch: cfg.defaultBranch, baseSha, targetSha, files, findingsCount: 0, findingsBySeverity: {}, summary: "No added or updated files since the last successful run.", startedAt, completedAt: new Date().toISOString() });
    progress("complete", { status: "no-changes", targetSha });
    return;
  }

  if (!fs.existsSync(path.join(RUNNER, "node_modules", ".bin", "deepsec"))) {
    progress("installing", { message: "deepsec@" + cfg.deepsecVersion });
    writeJson(path.join(RUNNER, "package.json"), {
      private: true,
      dependencies: {
        deepsec: cfg.deepsecVersion,
        // Satisfy deepsec's Claude agent peer independently from the older
        // Anthropic SDK version pinned inside its optional Pi agent.
        "@anthropic-ai/sdk": "0.93.0",
      },
      // deepsec 2.3.7 pins the Pi agent to undici 8.5.0. Keep the nested
      // dependency on its patched, API-compatible release until upstream does.
      overrides: { "@earendil-works/pi-coding-agent": { undici: "8.9.0" } },
    });
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: RUNNER });
  }
  const { minimatch } = await import("minimatch");
  const defaultIgnorePaths = ["**/node_modules/**", "**/.git/**", "**/.deepsec/data/**", "**/dist/**", "**/build/**", "**/target/**", "**/.next/**", "**/coverage/**", "**/.turbo/**", "**/__tests__/**", "**/*.test.{ts,tsx,js,jsx}", "**/*.spec.{ts,tsx,js,jsx}", "**/test/**", "**/tests/**", "**/fixtures/**", "**/testserver/**", "**/*.d.ts", "**/jest-setup.*", "**/*.mdx", "**/*.md", "**/content/docs/**", "**/content/docs-wip/**"];
  const ignorePaths = [...defaultIgnorePaths, ...cfg.ignorePaths];
  const trackedFileCount = files.length;
  files = files.filter((file) => !ignorePaths.some((glob) => minimatch(file, glob, { dot: true, nocase: false })));
  progress("change-set", { files: files.length, ignoredFiles: trackedFileCount - files.length, baseSha, targetSha });
  const deepsec = path.join(RUNNER, "node_modules", ".bin", "deepsec");
  if (!fs.existsSync(path.join(WORK, "deepsec.config.ts"))) {
    progress("scaffolding");
    run(deepsec, ["init", WORK, REPO, "--id", cfg.id, "--scaffold-only"]);
  }
  const nodeModules = path.join(WORK, "node_modules");
  if (!fs.existsSync(nodeModules)) fs.symlinkSync(path.join(RUNNER, "node_modules"), nodeModules, "dir");

const configSource = 'import { defineConfig } from "deepsec/config";\n' +
  'export default defineConfig(' + JSON.stringify({ ai: { mode: "gateway", provider: "vercel" }, defaultAgent: cfg.agent, defaultModel: cfg.model, defaultThinkingLevel: cfg.thinkingLevel, projects: [{ id: cfg.id, root: REPO, githubUrl: "https://github.com/" + cfg.repository + "/blob/" + cfg.defaultBranch, infoMarkdown: cfg.context, promptAppend: cfg.promptAppend, priorityPaths: cfg.priorityPaths }] }) + ');\n';
  fs.writeFileSync(path.join(WORK, "deepsec.config.ts"), configSource);
  fs.mkdirSync(path.join(WORK, "data", cfg.id), { recursive: true });
  writeJson(path.join(WORK, "data", cfg.id, "config.json"), { priorityPaths: cfg.priorityPaths, ignorePaths: cfg.ignorePaths, promptAppend: cfg.promptAppend });
  fs.writeFileSync(path.join(WORK, "data", cfg.id, "INFO.md"), cfg.context + "\n");
  let checkpoint = safeJson(checkpointPath, null);
  if (checkpoint?.targetSha !== targetSha || checkpoint?.configurationKey !== configurationKey() || JSON.stringify(checkpoint?.files) !== JSON.stringify(files)) {
    checkpoint = newCheckpoint(targetSha, files);
  } else {
    checkpoint = refreshCheckpoint(checkpoint);
  }
  writeJson(checkpointPath, checkpoint);
  const completedFiles = new Set(checkpoint.completedFiles);
  const processFiles = files.filter((file) => !completedFiles.has(file));
  progress("checkpoint", { totalFiles: files.length, completedFiles: completedFiles.size, remainingFiles: processFiles.length, targetSha });
  if (processFiles.length === 0) {
    finalizeCheckpoint(checkpoint, targetSha, baseSha, files);
    return;
  }
  const filesPath = path.join(RUNNER, "files.txt");
  fs.writeFileSync(filesPath, processFiles.join("\n") + "\n");
  const commentPath = path.join(RUNNER, "comment.md");
  try { fs.unlinkSync(commentPath); } catch {}

  const concurrency = Math.max(1, cfg.sandbox.vcpus - 1);
  const deepsecArgs = ["process", "--files-from", filesPath, "--project-id", cfg.id, "--root", REPO, "--agent", cfg.agent, "--model", cfg.model, "--thinking-level", cfg.thinkingLevel, "--concurrency", String(concurrency), "--batch-size", String(cfg.batchSize), "--comment-out", commentPath];
  progress("deepsec-running", { files: processFiles.length, totalFiles: files.length, concurrency, batchSize: cfg.batchSize, model: cfg.model });
  const status = await new Promise((resolve, reject) => {
    const child = spawn(deepsec, deepsecArgs, { cwd: WORK, env: process.env, stdio: "inherit" });
    const heartbeat = setInterval(() => progress("deepsec-running", { files: processFiles.length, totalFiles: files.length, concurrency, batchSize: cfg.batchSize, model: cfg.model }), 60_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearInterval(heartbeat);
      if (signal) reject(new Error("deepsec terminated by " + signal));
      else resolve(code ?? -1);
    });
  });
  if (status !== 0 && status !== 1) throw new Error("deepsec failed with exit " + status);
  const hasComment = fs.existsSync(commentPath) && fs.statSync(commentPath).size > 0;
  if (status === 1 && !hasComment) {
    throw new Error("deepsec exited 1 without a findings report; treating it as an agent, quota, or credential failure");
  }
  checkpoint = refreshCheckpoint(checkpoint);
  writeJson(checkpointPath, checkpoint);
  const remaining = files.filter((file) => !new Set(checkpoint.completedFiles).has(file));
  if (remaining.length > 0) throw new Error("deepsec exited without completing " + remaining.length + " file(s)");
  finalizeCheckpoint(checkpoint, targetSha, baseSha, files);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  progress("failed", { message });
  console.error(error);
  process.exitCode = 2;
}
`;
