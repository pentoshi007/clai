import { argumentHint, isArgumentRejection, type McpFailureContext, type McpFailureHint } from "../mcp/argument-hint.js";
import type { ReaAvailability } from "./availability.js";

const PATH_KEYS = /^(?:path|file|file_path|filepath|binary|binary_path|app|app_path|executable|input|input_path|target|target_path)$/i;
const TARGET_CODES = new Set(["architecture_unsupported", "target_format_unsupported", "target_unsupported"]);
const OPEN_TOOL = "open_binary";
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const REJECTION_CODE = /^[a-z][a-z0-9_]{0,47}$/;
const MAX_SUMMARY_CHARS = 120;

interface Rejection {
  readonly provider: string;
  readonly code: string;
  readonly architectures: readonly string[];
  readonly universal: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorOf(output: string): Record<string, unknown> | undefined {
  const text = output.trimStart();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

function rejections(details: Record<string, unknown>): Rejection[] {
  if (!Array.isArray(details.rejections)) return [];
  return details.rejections.flatMap((entry): Rejection[] => {
    if (!isRecord(entry) || typeof entry.provider_id !== "string" || !PROVIDER_ID.test(entry.provider_id)) return [];
    if (typeof entry.code !== "string" || !REJECTION_CODE.test(entry.code)) return [];
    const diagnostics = isRecord(entry.diagnostics) ? entry.diagnostics : {};
    const architectures = Array.isArray(diagnostics.available_architectures)
      ? diagnostics.available_architectures.filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9_]{1,16}$/.test(value))
      : [];
    return [{
      provider: entry.provider_id,
      code: entry.code,
      architectures,
      universal: diagnostics.target_format === "mach-o-universal",
    }];
  });
}

function describe(code: string): string {
  switch (code) {
    case "not_configured": return "not configured";
    case "executable_missing": return "launcher or runtime missing";
    case "architecture_unsupported": return "cannot open a universal Mach-O";
    case "target_format_unsupported": return "does not support this file format";
    default: return code.replace(/_/g, " ").slice(0, MAX_SUMMARY_CHARS);
  }
}

function providerFailure(operation: string, error: Record<string, unknown>): string | undefined {
  const details = isRecord(error.details) ? error.details : undefined;
  if (!details || !Array.isArray(details.candidate_ids) || details.candidate_ids.length === 0) return undefined;
  const found = rejections(details);
  if (found.length === 0) return undefined;
  const tool = typeof details.operation === "string" && /^[A-Za-z0-9_]{1,64}$/.test(details.operation) ? details.operation : operation;
  const byProvider = new Map<string, Rejection[]>();
  for (const entry of found) byProvider.set(entry.provider, [...(byProvider.get(entry.provider) ?? []), entry]);
  const states = [...byProvider].map(([provider, entries]) => `${provider}: ${[...new Set(entries.map((entry) => describe(entry.code)))].join(" and ")}`);
  const unusable = [...byProvider.values()].filter((entries) => entries.some((entry) => !TARGET_CODES.has(entry.code))).length;
  const blockedByTarget = [...byProvider.values()].some((entries) => entries.every((entry) => TARGET_CODES.has(entry.code)));
  const lines = [`REA ${tool} needs an analysis engine (tools marked ^) and none can serve this target now:`, ...states.map((state) => `- ${state}`)];
  const universal = found.find((entry) => entry.universal);
  if (universal && blockedByTarget) {
    const architectures = [...new Set(found.flatMap((entry) => entry.architectures))];
    lines.push(`This target is a universal Mach-O${architectures.length > 0 ? ` (${architectures.join(", ")})` : ""}. Thin one slice into the session scratch directory, for example lipo "<path>" -thin <arch> -output "<scratch>/<name>-<arch>", call ${OPEN_TOOL} on that file, then retry.`);
  }
  if (unusable === byProvider.size) {
    lines.push("No engine is ready. Do not retry this or other ^ tools and do not install anything yourself: tell the user to run /rea engines (it can install Ghidra on request), and continue with # tools that lack ^ and other REA tools.");
  }
  return lines.join("\n");
}

function outsideSchema(context: McpFailureContext): string[] {
  const known = new Set(Object.keys(context.tool.inputSchema.properties));
  return Object.keys(context.args).filter((key) => !known.has(key));
}

export function reaFailureHint(availability: () => ReaAvailability | undefined): McpFailureHint {
  return (context) => {
    const { tool, output } = context;
    const error = errorOf(output);
    if (error?.code === "provider_unavailable") return providerFailure(tool.toolName, error);
    if (error?.code === "target_unavailable") {
      return `${output}\nNo target is open. If the user already named a target, call mcp.clai-rea.${OPEN_TOOL} with its absolute path now, then retry this call.`;
    }
    if (!isArgumentRejection(output)) return undefined;
    const stray = outsideSchema(context).filter((key) => PATH_KEYS.test(key));
    const marks = availability();
    if (stray.length === 0 || (marks && !marks.open.has(tool.toolName))) return undefined;
    return `${output}\n${argumentHint(tool)}\n${tool.toolName} acts on the binary opened by ${OPEN_TOOL} and takes no ${stray[0]} argument: call mcp.clai-rea.${OPEN_TOOL} once with {"path": <absolute path>}, then call ${tool.toolName} again without ${stray[0]}.`;
  };
}
