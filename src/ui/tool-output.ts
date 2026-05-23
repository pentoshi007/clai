import { readFile } from "node:fs/promises";
import chalk from "chalk";

export interface ToolOutputSnapshot {
  id: string;
  label: string;
  artifactPath?: string | undefined;
  fullText?: string | undefined;
  summary?: string | undefined;
}

interface LivePane {
  append(chunk: string): void;
  finish(): void;
}

let lastSnapshot: ToolOutputSnapshot | undefined;
let expanded = false;
let renderedLines = 0;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function countRows(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function eraseRenderedBlock(): void {
  if (!process.stdout.isTTY || renderedLines === 0) {
    renderedLines = 0;
    return;
  }
  for (let i = 0; i < renderedLines; i += 1) {
    process.stdout.write("\r\x1b[2K");
    if (i < renderedLines - 1) process.stdout.write("\x1b[1A");
  }
  renderedLines = 0;
}

function formatHint(snapshot: ToolOutputSnapshot, next = "show"): string {
  const suffix = snapshot.artifactPath
    ? chalk.dim(`  saved: ${snapshot.artifactPath}`)
    : "";
  return chalk.dim(`  Ctrl+O ${next} full output`) + suffix;
}

async function loadFullOutput(snapshot: ToolOutputSnapshot): Promise<string> {
  if (snapshot.artifactPath) {
    return readFile(snapshot.artifactPath, "utf8");
  }
  return snapshot.fullText ?? "";
}

function renderExpandedBlock(snapshot: ToolOutputSnapshot, fullOutput: string): string {
  const summary = snapshot.summary?.trim() || "AI summary is not available yet.";
  return [
    chalk.dim(`--- full output: ${snapshot.label} ---`),
    chalk.dim(fullOutput.trimEnd()),
    chalk.dim(`--- summary ---`),
    summary,
    formatHint(snapshot, "hide"),
    "",
  ].join("\n");
}

export function rememberToolOutput(snapshot: ToolOutputSnapshot): void {
  eraseRenderedBlock();
  lastSnapshot = snapshot;
  expanded = false;
}

export function updateLastToolSummary(summary: string): void {
  if (!lastSnapshot) return;
  lastSnapshot = { ...lastSnapshot, summary };
}

export function renderToolOutputHint(): string {
  return lastSnapshot ? formatHint(lastSnapshot) : "";
}

export function hasToolOutputSnapshot(): boolean {
  return Boolean(lastSnapshot);
}

export async function toggleLastToolOutput(): Promise<void> {
  if (!lastSnapshot) {
    process.stdout.write(chalk.dim("\n  No tool output to show.\n"));
    return;
  }

  if (expanded) {
    eraseRenderedBlock();
    expanded = false;
    return;
  }

  eraseRenderedBlock();
  const full = await loadFullOutput(lastSnapshot);
  const block = renderExpandedBlock(lastSnapshot, full);
  process.stdout.write(`\n${block}`);
  renderedLines = countRows(stripAnsi(`\n${block}`));
  expanded = true;
}

export function createToolLivePane(label: string, maxRows = 10): LivePane {
  if (!process.stdout.isTTY) {
    return {
      append: () => {},
      finish: () => {},
    };
  }

  let lines: string[] = [];
  let partial = "";
  let liveRows = 0;

  const erase = (): void => {
    if (liveRows === 0) return;
    for (let i = 0; i < liveRows; i += 1) {
      process.stdout.write("\r\x1b[2K");
      if (i < liveRows - 1) process.stdout.write("\x1b[1A");
    }
    liveRows = 0;
  };

  const render = (): void => {
    erase();
    const width = Math.max(40, Math.min(process.stdout.columns ?? 100, 180));
    const visible = [...lines, partial]
      .filter((line) => line.length > 0)
      .slice(-maxRows)
      .map((line) =>
        line.length > width - 4 ? `${line.slice(0, width - 5)}...` : line,
      );
    const body = [
      chalk.dim(`  running ${label}`),
      ...visible.map((line) => chalk.dim(`  ${line}`)),
    ].join("\n");
    process.stdout.write(body);
    liveRows = countRows(body);
  };

  return {
    append(chunk: string): void {
      const normalized = chunk.replace(/\r/g, "");
      const parts = normalized.split("\n");
      partial += parts.shift() ?? "";
      if (parts.length > 0) {
        lines.push(partial);
        lines.push(...parts.slice(0, -1));
        partial = parts[parts.length - 1] ?? "";
      }
      if (lines.length > maxRows * 4) lines = lines.slice(-maxRows * 2);
      render();
    },
    finish(): void {
      erase();
    },
  };
}

