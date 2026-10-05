import { safeCwd } from "../os/cwd.js";
import { getActiveProjectRoot } from "../agent/project-root.js";
import { redactSecrets } from "../llm/provider.js";
import { resolveFsToolPath } from "../tools/fs.js";
import type { ToolCall } from "../types.js";

export interface OperationReview {
  readonly title: string;
  readonly body: string;
}

const SECRET_FIELD = /^(?:password|passwd|secret|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|token)$|(?:_PASSWORD|_SECRET|_TOKEN|_API_KEY)$/i;

export function reviewDisplayText(value: string): string {
  return redactSecrets(value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function reviewValue(key: string, value: unknown): unknown {
  if (SECRET_FIELD.test(key) && value !== undefined && value !== null) return "[redacted]";
  return typeof value === "string" ? reviewDisplayText(value) : value;
}

function stringSections(value: unknown, label = "args"): string[] {
  if (typeof value === "string") {
    return value.includes("\n") || value.length > 160 ? [`${label}:\n${value}`] : [];
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => stringSections(entry, `${label}.${key}`));
}

function resolvedPaths(call: ToolCall): string[] {
  if (!call.name.startsWith("fs.")) return [];
  const paths: string[] = typeof call.args.path === "string" ? [call.args.path] : [];
  if ((call.name === "fs.writeMany" || call.name === "fs.read") && Array.isArray(call.args.files)) {
    for (const entry of call.args.files) {
      if (entry && typeof entry === "object" && "path" in entry && typeof entry.path === "string") paths.push(entry.path);
    }
  }
  return paths.map((path) => {
    try { return `Resolved path: ${reviewDisplayText(resolveFsToolPath(path))}`; }
    catch { return `Path: ${reviewDisplayText(path)} (could not resolve)`; }
  });
}

export function formatOperationReview(call: ToolCall): OperationReview {
  const json = JSON.stringify(call.args, reviewValue, 2);
  const args: unknown = JSON.parse(json);
  const cwd = typeof call.args.cwd === "string" ? call.args.cwd : safeCwd();
  const body = [
    `Operation: ${reviewDisplayText(call.name)}`,
    `Working directory: ${reviewDisplayText(cwd)}`,
    `Active folder: ${reviewDisplayText(getActiveProjectRoot() ?? safeCwd())}`,
    ...resolvedPaths(call),
    "",
    "Complete arguments (sensitive values masked):",
    json,
    ...stringSections(args).map((section) => `\n${section}`),
    "",
    "Viewing this operation does not approve or execute it. Close the pager to return to the pending prompt.",
  ].join("\n");
  return { title: `Review operation · ${call.name}`, body };
}
