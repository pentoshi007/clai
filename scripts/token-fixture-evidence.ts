import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { BackgroundJobReceipt, ToolResult } from "../src/types.js";

export interface FixtureToolExecution {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: ToolResult;
  readonly job?: BackgroundJobReceipt;
  readonly turn: number;
}
export interface FixtureEvidence {
  readonly executions: readonly FixtureToolExecution[];
  readonly observedCalls: readonly { readonly name: string; readonly turn: number }[];
  readonly responderReceipts?: readonly { readonly jobId: string; readonly read: boolean; readonly status: string; readonly exitCode?: number | undefined }[];
}
export const emptyFixtureEvidence: FixtureEvidence = { executions: [], observedCalls: [] };

export function runIndependentAssertions(root: string, assertions: string): boolean {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", assertions], { cwd: root, timeout: 10_000, encoding: "utf8" });
  return !result.error && result.status === 0;
}

export async function immutableFilesMatch(root: string, files: Readonly<Record<string, string>>, mutable: readonly string[]): Promise<boolean> {
  const allowed = new Set(mutable);
  const matches = await Promise.all(Object.entries(files).filter(([name]) => !allowed.has(name)).map(async ([name, content]) => {
    try { return await readFile(join(root, name), "utf8") === content; }
    catch { return false; }
  }));
  return matches.every(Boolean);
}

export function verifiedBackgroundCheck(answer: string, evidence: FixtureEvidence): boolean {
  const launches = evidence.executions.filter((entry) => entry.name === "shell.exec");
  if (launches.length !== 1) return false;
  const launch = launches[0]!;
  const receipt = launch.result.backgroundJob;
  const correctLaunch = launch.result.ok && receipt && launch.args.background === "always" && launch.args.responder !== true &&
    typeof launch.args.command === "string" && /(?:^|\s)(?:node|["']?[^\s]*\/node["']?)\s+["']?(?:[^\s]*\/)?check\.mjs["']?\s*$/.test(launch.args.command);
  if (!correctLaunch || !receipt) return false;
  const waits = evidence.executions.filter((entry) => entry.name === "shell.wait");
  if (waits.length !== 1 || evidence.observedCalls.some((entry) => entry.name === "shell.jobs" || entry.name === "shell.tail")) return false;
  const wait = waits[0]!;
  return evidence.executions.indexOf(wait) > evidence.executions.indexOf(launch) && wait.args.id === receipt.id && wait.result.ok &&
    wait.job?.id === receipt.id && wait.job.status === "exited" && wait.job.exitCode === 0 &&
    /READY_CHECK:\s*42\b/.test(wait.result.output) && /READY_CHECK:\s*42\b/.test(answer);
}

export function terminalTranscriptIsCursorSafe(evidence: FixtureEvidence): boolean {
  let cursor: number | undefined;
  let sessionId: string | undefined;
  for (const entry of evidence.executions.filter((value) => value.name.startsWith("terminal."))) {
    const receipt = entry.result.interactiveSession;
    if (!receipt) return false;
    if (receipt.operation === "start") {
      if (sessionId) return false;
      sessionId = receipt.sessionId;
      cursor = receipt.cursor;
      continue;
    }
    if (entry.name === "terminal.list") continue;
    if (entry.args.id !== sessionId) return false;
    if (entry.name === "terminal.read" && entry.args.cursor !== cursor) return false;
    if (entry.name === "terminal.send" && entry.args.cursor !== undefined && entry.args.cursor !== cursor) return false;
    if ((receipt.operation === "read" || receipt.operation === "send") && receipt.page) {
      if (cursor !== undefined && receipt.page.nextCursor < cursor) return false;
      cursor = receipt.page.nextCursor;
    }
  }
  return sessionId !== undefined;
}

export function isFixtureTestExecution(entry: FixtureToolExecution): boolean {
  return entry.name === "shell.exec" && typeof entry.args.command === "string" &&
    /(?:\bnode\s+--test\b|\bnpm\s+(?:run\s+)?test\b)/.test(entry.args.command);
}
