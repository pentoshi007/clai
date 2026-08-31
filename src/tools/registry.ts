import type { ToolCall, ToolResult } from "../types.js";
import {
  createInteractiveSessionHandlers,
  INTERACTIVE_SESSION_TOOL_NAMES,
} from "./interactive-session-tools.js";
import { instructionsRecordTool } from "./instructions.js";
import {
  canonicalizeExternalToolName,
  externalToolDispatcher,
  externalToolNames,
  isExternalToolName,
} from "./external-tools.js";
import { isCanonicalToolName } from "../mcp/names.js";
import { skillListTool, skillLoadTool } from "./skills.js";
import { resolveNmapTimeoutPolicy } from "./nmap-runner.js";
import { type ToolRunOptions, type ToolHandler } from "./tool-types.js";
import {
  elidedStubReuseMessage,
  findElidedStubArg,
} from "../agent/message-slim.js";
import { fromWireName } from "../llm/tool-protocol.js";
import { NON_REGISTRY_TOOL_NAMES } from "./definitions.js";
import {
  compileBatchFailMode,
  evaluateCancelTargets,
  formatBatchCancelReason,
  parseBatchFailPolicy,
} from "./batch-fail-policy.js";
import { buildPentestReconNmapArgv } from "./handlers/nmap-preparation.js";
import { toolRegistry_SHELL_1 } from "./handlers/shell-1.js";
import { toolRegistry_FILES_1 } from "./handlers/files-1.js";
import { toolRegistry_SHELL_2 } from "./handlers/shell-2.js";
import { toolRegistry_NETWORK_1 } from "./handlers/network-1.js";
import { toolRegistry_WEB } from "./handlers/web.js";
import { toolRegistry_CONTEXT_1 } from "./handlers/context-1.js";
import { toolRegistry_NETWORK_2 } from "./handlers/network-2.js";
import { toolRegistry_PENTEST } from "./handlers/pentest.js";
import { toolRegistry_ORCHESTRATION_1 } from "./handlers/orchestration-1.js";
import { toolRegistry_NETWORK_3 } from "./handlers/network-3.js";
import { toolRegistry_ORCHESTRATION_2 } from "./handlers/orchestration-2.js";
import { toolRegistry_CONTEXT_2 } from "./handlers/context-2.js";
import { toolRegistry_SHELL_3 } from "./handlers/shell-3.js";
import { toolRegistry_FILES_2 } from "./handlers/files-2.js";
import { normalizeToolCall } from "./call-normalization.js";

export { normalizeToolCall };
export { buildPentestReconNmapArgv };

export type { ToolRunOptions, ToolHandler };
export {
  parseBatchFailPolicy,
  compileBatchFailMode,
  evaluateCancelTargets,
  formatBatchCancelReason,
} from "./batch-fail-policy.js";

export interface ScanResourceEstimate {
  profile: "standard" | "deep" | "full";
  estimatedSeconds: number;
  timeoutMs: number;
  durableRecommended: boolean;
}

export function estimateScanResources(
  argv: readonly string[],
): ScanResourceEstimate {
  const policy = resolveNmapTimeoutPolicy(argv, {});
  const estimatedSeconds =
    policy.depth === "full" ? 1_800 : policy.depth === "deep" ? 600 : 120;
  return {
    profile: policy.depth,
    estimatedSeconds,
    timeoutMs: policy.timeoutMs,
    durableRecommended: policy.depth !== "standard",
  };
}

export const toolRegistry: Record<string, ToolHandler> = {
  ...createInteractiveSessionHandlers(),
  ...toolRegistry_SHELL_1,
  ...toolRegistry_FILES_1,
  ...toolRegistry_SHELL_2,
  ...toolRegistry_NETWORK_1,
  ...toolRegistry_WEB,
  ...toolRegistry_CONTEXT_1,
  ...toolRegistry_NETWORK_2,
  ...toolRegistry_PENTEST,
  ...toolRegistry_ORCHESTRATION_1,
  ...toolRegistry_NETWORK_3,
  ...toolRegistry_ORCHESTRATION_2,
  ...toolRegistry_CONTEXT_2,
  ...toolRegistry_SHELL_3,
  ...toolRegistry_FILES_2,
  async "skill.list"(args) {
    return skillListTool(args);
  },
  async "skill.load"(args) {
    return skillLoadTool(args);
  },
  async "instructions.record"(args) {
    return instructionsRecordTool(args);
  },
};

export function availableToolNames(): string[] {
  return Object.keys(toolRegistry);
}

export function knownToolNames(): string[] {
  return [...Object.keys(toolRegistry), ...NON_REGISTRY_TOOL_NAMES].sort();
}

export function unknownToolErrorMessage(name: string): string {
  const known = knownToolNames();
  const external = externalToolNames();
  const mapped = fromWireName(name);
  const hint =
    mapped && mapped !== name && known.includes(mapped)
      ? ` Did you mean ${mapped}?`
      : "";
  const extra =
    external.length > 0 ? `, ${[...external].sort().join(", ")}` : "";
  return `Unknown tool: ${name}.${hint} Tool names are dotted namespace.action pairs (task.update, not task_update). Available tools: ${known.join(", ")}${extra}`;
}

/**
 * Pull the result URLs out of a web.search success output. The output is a
 * one-line summary followed by a JSON `{ results: [{url, ...}] }` block; we
 * parse from the first brace. Falls back to a regex scan if JSON parsing
 * fails so a slightly different shape still yields fetchable URLs.
 */
export function extractResultUrls(output: string): string[] {
  const brace = output.indexOf("{");
  if (brace >= 0) {
    try {
      const parsed = JSON.parse(output.slice(brace)) as {
        results?: Array<{ url?: unknown }>;
      };
      const urls = (parsed.results ?? [])
        .map((r) => (typeof r.url === "string" ? r.url : ""))
        .filter((u) => u.startsWith("http://") || u.startsWith("https://"));
      if (urls.length > 0) return urls;
    } catch {
      // fall through to regex
    }
  }
  const matches = output.match(/https?:\/\/[^\s"]+/g);
  return matches ? matches.map((u) => u.replace(/[",]+$/, "")) : [];
}

export function normalizeToolResult(
  name: string,
  result: ToolResult,
): ToolResult {
  if (result.output.trim()) return result;
  const exit =
    result.exitCode === undefined ? "" : ` (exit=${result.exitCode})`;
  return {
    ...result,
    output: result.ok
      ? `Tool ${name} completed successfully${exit}, but produced no textual output.`
      : `Tool ${name} failed${exit} without textual output.`,
  };
}

export async function runToolCall(
  call: ToolCall,
  options: ToolRunOptions = {},
): Promise<ToolResult> {
  const normalized = normalizeToolCall(call);
  const handler = toolRegistry[normalized.name];
  if (!handler) {
    const dispatcher = externalToolDispatcher();
    const canonical = dispatcher
      ? canonicalizeExternalToolName(normalized.name)
      : normalized.name;
    if (dispatcher?.hasTool(canonical) === true) {
      return normalizeToolResult(
        canonical,
        await dispatcher.callTool(canonical, normalized.args, {
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      );
    }
    if (isCanonicalToolName(normalized.name)) {
      return {
        ok: false,
        exitCode: 1,
        output:
          dispatcher?.unavailableToolMessage?.(normalized.name) ??
          `MCP tool "${normalized.name}" is unavailable: no MCP server is connected. Run /mcp status.`,
      };
    }
    throw new Error(unknownToolErrorMessage(normalized.name));
  }
  const elidedStub = findElidedStubArg(normalized.args);
  if (elidedStub) {
    return {
      ok: false,
      exitCode: 1,
      output: elidedStubReuseMessage(elidedStub.key),
    };
  }
  return normalizeToolResult(
    normalized.name,
    await handler(normalized.args, options),
  );
}

/**
 * Tools that may run **in parallel** inside `tool.batch` without racing
 * mutates. Anything outside this set is still allowed in a batch but is
 * forced serial (and may require confirmation — see {@link runToolBatch}).
 *
 * Kept for tests and call-sites that want the parallel-safe set.
 */
export const BATCH_SAFE_TOOLS = new Set([
  "fs.read",
  "fs.list",
  "fs.search",
  "http.fetch",
  "sysinfo",
  "dns.lookup",
  "whois.lookup",
  "net.context",
  "net.scan",
  "net.pingSweep",
  "pentest.recon",
  "tool.check",
  "wordlist.find",
  "image.ocr",
  "image.view",
  "pdf.read",
  "web.search",
  "web.fetch",
  "shell.jobs",
  "shell.tail",
  "skill.list",
  "skill.load",
]);

/**
 * Tools that must never ride inside tool.batch (session bookkeeping /
 * recursive batch / mode handoff). Everything else registered is allowed.
 */

/** Default batch ceiling; the model may override it with timeoutMs. */
/** Progress heartbeats keep the outer tool stall watchdog alive. */

/**
 * Normalize a batch child tool name: wire forms (`tool_check`, `fs_read`)
 * and dotted names both resolve to the registry canonical name.
 */
export function normalizeBatchToolName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (toolRegistry[trimmed] || NON_REGISTRY_TOOL_NAMES.has(trimmed))
    return trimmed;
  const external = canonicalizeExternalToolName(trimmed);
  if (isExternalToolName(external)) return external;
  const mapped = fromWireName(trimmed);
  if (mapped && (toolRegistry[mapped] || NON_REGISTRY_TOOL_NAMES.has(mapped)))
    return mapped;
  // Underscore-all form that fromWireName may still leave as-is if unregistered
  // mid-name (tool_check → tool.check via first underscore heuristic).
  if (!trimmed.includes(".") && trimmed.includes("_")) {
    const dotted = trimmed.replace(/_/g, ".");
    if (toolRegistry[dotted] || NON_REGISTRY_TOOL_NAMES.has(dotted))
      return dotted;
  }
  return trimmed;
}
