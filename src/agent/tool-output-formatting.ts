import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fixOwner, handlePermissionError } from "../os/permissions.js";
import { reduceToolOutput } from "../tools/policies/output-policy.js";
import type { ToolCall, ToolResult } from "../types.js";

function safeArtifactName(name: string): string {
  return (
    name.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") ||
    "tool-output"
  );
}

export async function saveToolOutput(
  call: ToolCall,
  output: string,
): Promise<string | undefined> {
  if (!output.trim()) return undefined;
  const dir = join(homedir(), ".clai", "outputs");
  try {
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}-${safeArtifactName(call.name)}.txt`);
    await writeFile(path, `${output}\n`, "utf8");
    await fixOwner(path);
    return path;
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export function summarizeOutput(
  output: string,
  maxChars = 8_000,
): { text: string; truncated: boolean } {
  if (output.length <= maxChars) return { text: output, truncated: false };

  const lines = output.split(/\r?\n/);
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  const half = Math.floor(maxChars / 2);

  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > half) break;
    head.push(line);
    used += cost;
  }

  used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.length + 1;
    if (used + cost > half) break;
    tail.unshift(line);
    used += cost;
  }

  return {
    text: [
      ...head,
      `... (${lines.length.toLocaleString()} output lines truncated) ...`,
      ...tail,
    ].join("\n"),
    truncated: true,
  };
}

// Tools whose output is the actual content the model needs verbatim (file
// bodies, listings, search hits). Running these through the security-signal
// `genericReducer` was wrong: it ranks lines by pentest keywords and drops
// the rest, so source code came back as a fragmentary head+tail — the model
// saw a "truncated" file and kept re-reading it in wasted retries. For these
// we pass the raw content through (up to a generous cap) and point the model
// at the saved artifact when it exceeds the cap.
const PASSTHROUGH_TOOLS = new Set<string>([
  "fs.read",
  "fs.list",
  "fs.search",
  "fs.edit",
  "pdf.read",
]);
const PASSTHROUGH_CAP_CHARS = 400_000;
// web.fetch/http.fetch pull in arbitrary third-party pages/API responses that
// can be hundreds of KB (e.g. a large OpenAPI spec). Unlike local files the
// model asked to read, this content is never bounded by the user's own
// project, so it must be capped like every other tool's context output —
// otherwise a single fetch can single-handedly blow the context budget and
// starve the model of room to actually respond (observed as empty/garbled
// completions on smaller-context-window models after a big fetch).
const WEB_FETCH_CAP_CHARS = 20_000;

export function formatToolContext(call: ToolCall, result: ToolResult): string {
  const output = result.output.trim();
  if (!output) return "";
  if (call.name === "web.fetch" || call.name === "http.fetch") {
    const { text, truncated } = summarizeOutput(output, WEB_FETCH_CAP_CHARS);
    if (!truncated) return text;
    const saved = result.outputPath
      ? `\n\n[Response exceeds ${WEB_FETCH_CAP_CHARS.toLocaleString()} chars; showing the head and tail. The FULL response is saved at: ${result.outputPath} — re-fetch a narrower URL or read the saved file if you need the middle.]`
      : `\n\n[Response exceeds ${WEB_FETCH_CAP_CHARS.toLocaleString()} chars; only head and tail shown.]`;
    return `${text}${saved}`.trim();
  }
  // Pass-through tools: never reduce — the model needs the real content.
  if (PASSTHROUGH_TOOLS.has(call.name)) {
    const { text, truncated } = summarizeOutput(output, PASSTHROUGH_CAP_CHARS);
    if (!truncated) return text;
    const saved = result.outputPath
      ? `\n\n[File content exceeds ${PASSTHROUGH_CAP_CHARS.toLocaleString()} chars; showing the head and tail. The FULL content is saved at: ${result.outputPath} — re-read specific line ranges with fs.read if you need the middle.]`
      : `\n\n[File content exceeds ${PASSTHROUGH_CAP_CHARS.toLocaleString()} chars; only head and tail shown. Read it in smaller chunks if the middle is needed.]`;
    return `${text}${saved}`.trim();
  }
  let reduced: string | undefined;
  try {
    const command =
      call.name === "shell.exec" ? String(call.args.command ?? "") : call.name;
    const policy = reduceToolOutput(output, {
      toolName: call.name,
      command,
    });
    reduced = policy.summary.trim();
  } catch {
    reduced = undefined;
  }
  // Hard cap on the reduced text — reducers should already be small, but
  // never let one accidentally explode model context.
  const base = reduced && reduced.length > 0 ? reduced : output;
  const summary = summarizeOutput(base, 8_000);
  const saved = result.outputPath
    ? `\nFull output saved to: ${result.outputPath}`
    : "";
  return `${summary.text}${saved}`.trim();
}
