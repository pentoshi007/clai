const GATEWAY_ARG_ENVELOPES = new Set(["input", "arguments", "parameters"]);

import { shellQuoteToken } from "./shell-quoting.js";
import { fromWireName, sanitizeToolName } from "../llm/tool-protocol.js";
import type { ToolCall } from "../types.js";
import { NON_REGISTRY_TOOL_NAMES } from "./definitions.js";
import { toolRegistry } from "./registry.js";

/**
 * Keys that mean "this is a file/content payload, not a command line". When a
 * hallucinated call carries one of these, we refuse to synthesize shell text
 * from it: concatenating file content into a command line is how metacharacters
 * in model output become executed shell.
 */
const CONTENT_SHAPED_ARG_KEYS = new Set([
  "content",
  "contents",
  "body",
  "text",
  "data",
  "file_text",
  "filetext",
  "new_str",
  "newstr",
  "old_str",
  "oldstr",
  "patch",
  "diff",
  "source",
  "stdin",
  "input",
]);

/** Explicit command-bearing fields, in precedence order. */
const COMMAND_ARG_KEYS = [
  "command",
  "cmd",
  "commandLine",
  "command_line",
  "argv",
  "args",
  "arguments",
] as const;

/**
 * Build a shell command string from a bare-command tool call. Models often
 * emit the binary as the tool name (`sed`, `awk`, `git`, …) and put the rest
 * into an explicit `command`/`cmd`/`argv`/`args` field. Only those explicit
 * fields are honored: array forms are shell-quoted per element, and calls that
 * look like a file-write shape (content/body/text/patch/...) are rejected so
 * an unknown-tool error is surfaced instead of executing model text.
 */
function buildShellCommandFromCall(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  const trimmedName = name.trim();
  const keys = Object.keys(args);
  for (const key of keys) {
    if (CONTENT_SHAPED_ARG_KEYS.has(key.toLowerCase())) return undefined;
  }

  const asText = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) {
      const parts = value
        .filter((v) => typeof v === "string" || typeof v === "number")
        .map((v) => shellQuoteToken(String(v)));
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    return undefined;
  };

  let rest: string | undefined;
  for (const key of COMMAND_ARG_KEYS) {
    const text = asText(args[key]);
    if (text !== undefined) {
      rest = text;
      break;
    }
  }

  if (rest === undefined) {
    // No explicit command field. A name-only call with no other arguments is
    // still runnable (`whoami`); anything else is an unknown tool, not a
    // command to be assembled out of arbitrary model values.
    const meaningful = keys.filter(
      (key) => !["cwd", "timeoutMs", "iOwnThis", "own"].includes(key),
    );
    if (meaningful.length > 0) return undefined;
    return trimmedName || undefined;
  }

  const trimmedRest = rest.trim();
  if (!trimmedRest) return trimmedName || undefined;
  // Avoid a doubled binary when `rest` already begins with the tool name.
  const firstToken = trimmedRest.split(/\s+/)[0];
  if (!trimmedName.includes(" ") && firstToken === trimmedName) {
    return trimmedRest;
  }
  return `${trimmedName} ${trimmedRest}`.trim();
}

/**
 * Normalize a tool call before dispatch. If the name is not a registered
 * tool but looks like a bare shell command (no `namespace.` dot — clai tools
 * are all namespaced, e.g. `fs.read`, `web.search`), rewrite it into a
 * `shell.exec` call instead of dead-ending on "Unknown tool: sed". The
 * rewritten call still flows through the normal shell safety classifier, so
 * dangerous commands are gated exactly as a hand-written shell.exec would be.
 */
const CLASSIC_TOOL_ALIASES: Record<string, string> = {
  bash: "shell.exec",
  read: "fs.read",
  write: "fs.write",
  edit: "fs.edit",
  multiedit: "fs.edit",
  ls: "fs.list",
  glob: "fs.list",
  grep: "fs.search",
  webfetch: "web.fetch",
  websearch: "web.search",
};

function remapClassicArgs(call: ToolCall): ToolCall {
  const args = { ...(call.args ?? {}) };
  if (typeof args.file_path === "string" && args.path === undefined) {
    args.path = args.file_path;
    delete args.file_path;
  }
  if (typeof args.old_string === "string" && args.oldText === undefined) {
    args.oldText = args.old_string;
    delete args.old_string;
  }
  if (typeof args.new_string === "string" && args.newText === undefined) {
    args.newText = args.new_string;
    delete args.new_string;
  }
  return { name: call.name, args };
}

function unwrapGatewayToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(args);
  if (keys.length !== 1 || !GATEWAY_ARG_ENVELOPES.has(keys[0]!)) return args;
  const value = args[keys[0]!];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return args;
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : args;
  } catch {
    return args;
  }
}

export function normalizeToolCall(call: ToolCall): ToolCall {
  let name = typeof call.name === "string" ? call.name.trim() : "";
  const originalArgs = call.args ?? {};
  const classic = CLASSIC_TOOL_ALIASES[name.toLowerCase()];
  if (classic && !toolRegistry[name]) {
    const args = unwrapGatewayToolArgs(originalArgs);
    const hasShellShape = COMMAND_ARG_KEYS.some(
      (key) => args[key] !== undefined,
    );
    if (classic === "shell.exec" || !hasShellShape) {
      return remapClassicArgs({ name: classic, args });
    }
  }
  if (name && !toolRegistry[name]) {
    const cleaned = sanitizeToolName(name);
    const mapped = fromWireName(cleaned) ?? fromWireName(name) ?? cleaned;
    if (
      mapped &&
      (toolRegistry[mapped] ||
        NON_REGISTRY_TOOL_NAMES.has(mapped) ||
        mapped.startsWith("mcp."))
    ) {
      return { name: mapped, args: unwrapGatewayToolArgs(originalArgs) };
    }
    if (cleaned && cleaned !== name) name = cleaned;
  }
  if (toolRegistry[name]) {
    const args = unwrapGatewayToolArgs(originalArgs);
    return name === call.name && args === originalArgs ? call : { name, args };
  }
  if (!name || name.includes(".") || name.includes("/")) {
    return name === call.name ? call : { name, args: originalArgs };
  }
  const command = buildShellCommandFromCall(name, originalArgs);
  if (!command) return call;
  const shellArgs: Record<string, unknown> = { command };
  if (typeof originalArgs.cwd === "string") shellArgs.cwd = originalArgs.cwd;
  if (typeof originalArgs.timeoutMs === "number") {
    shellArgs.timeoutMs = originalArgs.timeoutMs;
  }
  return { name: "shell.exec", args: shellArgs };
}
