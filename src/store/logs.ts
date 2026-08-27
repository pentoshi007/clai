import { mkdir, readdir, rename, stat, appendFile, readFile, writeFile, rm, chown } from 'node:fs/promises';
import { fixOwner, handlePermissionError } from '../os/permissions.js';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from '../llm/provider.js';
import { getGlobalArtifactDir, getLogsDirRoot } from './paths.js';
import { getSessionWorkspaceParent } from './session-workspace.js';

const logsDir = getLogsDirRoot();
const maxLogBytes = 10 * 1024 * 1024;

function today(): string {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '');
}

export function getLogPath(): string {
  return join(logsDir, `clai-${today()}.log`);
}

async function rotateIfNeeded(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const info = await stat(path);
  if (info.size < maxLogBytes) return;
  const siblings = await readdir(logsDir).catch(() => []);
  const count = siblings.filter((name) => name.startsWith(`clai-${today()}.log.`)).length + 1;
  const newPath = `${path}.${count}`;
  await rename(path, newPath);
  await fixOwner(newPath);
}

export async function auditLog(event: string, payload: unknown = {}): Promise<void> {
  try {
    await mkdir(logsDir, { recursive: true });
    await fixOwner(logsDir);
    const path = getLogPath();
    await rotateIfNeeded(path);
    const entry = redactSecrets(JSON.stringify({ at: new Date().toISOString(), event, payload }));
    await appendFile(path, `${entry}\n`, 'utf8');
    await fixOwner(path);
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export async function clearAuditLogs(): Promise<{ removed: number }> {
  if (!existsSync(logsDir)) return { removed: 0 };
  const entries = await readdir(logsDir).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith('clai-')) continue;
    try {
      await rm(join(logsDir, entry), { force: true });
      removed += 1;
    } catch {
      // best-effort: keep going
    }
  }
  return { removed };
}

export function getLogsDir(): string {
  return logsDir;
}

const ARTIFACT_CLEANUP_CONCURRENCY = 64;

async function forEachArtifactEntry(
  entries: readonly string[],
  run: (entry: string) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(ARTIFACT_CLEANUP_CONCURRENCY, entries.length) },
    async () => {
      while (next < entries.length) {
        const entry = entries[next];
        next += 1;
        if (entry !== undefined) await run(entry);
      }
    },
  );
  await Promise.all(workers);
}

export async function clearArtifacts(): Promise<{ removed: number }> {
  let removed = 0;

  // 1) Global ~/.clai/outputs (or CLAI_ARTIFACT_DIR override)
  const globalDir = getGlobalArtifactDir();
  if (existsSync(globalDir)) {
    const entries = await readdir(globalDir).catch(() => []);
    await forEachArtifactEntry(entries, async (entry) => {
      try {
        await rm(join(globalDir, entry), { force: true, recursive: true });
        removed += 1;
      } catch {
        // best-effort
      }
    });
  }

  // 2) Per-session tool outputs under {tmpdir}/clai/*/temp
  const sessionsParent = getSessionWorkspaceParent();
  if (existsSync(sessionsParent)) {
    const sessionFolders = await readdir(sessionsParent).catch(() => []);
    await forEachArtifactEntry(sessionFolders, async (folder) => {
      const tempDir = join(sessionsParent, folder, "temp");
      const entries = await readdir(tempDir).catch(() => []);
      for (const entry of entries) {
        try {
          await rm(join(tempDir, entry), { force: true, recursive: true });
          removed += 1;
        } catch {
          // best-effort
        }
      }
    });
  }

  return { removed };
}

const diagnosticKeyAllowed = (key: string): boolean =>
  /(?:id|ids|status|state|reason|level|phase|capability|allowed|ok|exitCode|signal|bytes|count|duration|freshness|revision|version|tokens|Tokens|provider|model|dialect|step|protocol)$/i.test(
    key,
  ) ||
  /^(?:estimatedTotalTokens|systemTokens|userTokens|assistantTokens|toolResultTokens|toolSchemaTokens|messageCount|systemMessageCount|userMessageCount|assistantMessageCount|toolMessageCount|constitutionTokens|planTokens|scopeTokens|sessionStateTokens|compactionMemoryTokens|otherSystemTokens|toolDefinitionCount|tool_protocol)$/i.test(
    key,
  );

function diagnosticMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(diagnosticMetadata);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (diagnosticKeyAllowed(key)) output[key] = diagnosticMetadata(child);
  }
  return output;
}

/** Export local, metadata-only diagnostics. User prompts, project code, commands, and tool output are excluded by default. */
export async function exportDiagnostics(destination: string): Promise<{ path: string; events: number }> {
  const entries = (await readdir(logsDir).catch(() => []))
    .filter((name) => name.startsWith("clai-") && name.includes(".log"))
    .sort()
    .slice(-5);
  const events: Array<{ at?: string; event?: string; payload?: unknown }> = [];
  for (const entry of entries) {
    const text = await readFile(join(logsDir, entry), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { at?: string; event?: string; payload?: unknown };
        const row: { at?: string; event?: string; payload?: unknown } = {};
        if (typeof parsed.at === "string") row.at = parsed.at;
        if (typeof parsed.event === "string") row.event = parsed.event;
        if (parsed.payload !== undefined) row.payload = diagnosticMetadata(parsed.payload);
        events.push(row);
      } catch { /* Ignore partial/corrupt log lines. */ }
    }
  }
  const report = redactSecrets(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    privacy: "metadata-only; prompts, code, commands, secrets, and tool output omitted",
    events: events.slice(-10_000),
  }, null, 2));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${report}\n`, { mode: 0o600 });
  return { path: destination, events: Math.min(events.length, 10_000) };
}
