import type { ChatMessage, CompletionResult, NativeToolCall, ToolDefinition } from "../types.js";
import { fromWireName, sanitizeToolName } from "./tool-protocol.js";

const LEGACY_TOOL_NAMES: Readonly<Record<string, string>> = {
  shell: "shell.exec",
  bash: "shell.exec",
  read: "fs.read",
  write: "fs.write",
  edit: "fs.edit",
  webfetch: "web.fetch",
  websearch: "web.search",
};

export function zenToolName(name: string, tools: readonly ToolDefinition[]): string {
  const cleaned = sanitizeToolName(name);
  const canonical = fromWireName(cleaned);
  const direct = tools.find((tool) => tool.name === cleaned || tool.wireName === cleaned || tool.name === canonical);
  if (direct) return direct.name;
  const legacy = LEGACY_TOOL_NAMES[cleaned];
  return tools.find((tool) => tool.name === legacy)?.name ?? name;
}

export function zenRuntimeToolContract(tools: readonly ToolDefinition[]): string {
  const names = tools.map((tool) => `- ${tool.name}: native function ${tool.wireName}`).join("\n");
  return `CLAI RUNTIME TOOL CONTRACT
The OpenCode tool catalog and Code Mode instructions above are compatibility metadata, not executable runtime tools. This runtime is clai. Use ONLY the native functions listed below and their complete JSON schemas in this request; these override the compatibility catalog. Call native functions directly, never execute or JavaScript tools.namespace calls. Do not call bare shell, read, edit, write, grep, glob, question, skill or subagent from the compatibility catalog.
Tool arguments must be valid JSON matching the selected native function's schema, with quoted property names and correctly typed values. In textual tool blocks use the canonical dotted name; in native calls use the function name listed here. Never prepend a tool name to a shell command. shell.exec uses command, cwd and timeoutMs (milliseconds), not workdir or timeout. Its background is a string ("always", "never" or "auto"), not a boolean. fs.edit uses oldText/newText, not oldString/newString. For searches use shell.exec with a properly quoted rg command or fs.read with its supported pattern filter. Never invent grep/glob/execute tools.
This contract and the native schemas are supplied on every request, including after compaction. Historical summaries and old tool calls do not change the current tool names or argument shapes.
Available runtime tools:
${names}`;
}

function legacyToolArgs(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const args = { ...input };
  const fields = name === "shell" || name === "bash"
    ? { workdir: "cwd", timeout: "timeoutMs" }
    : { oldString: "oldText", newString: "newText" };
  for (const [oldName, newName] of Object.entries(fields)) {
    if (args[oldName] === undefined) continue;
    if (args[newName] === undefined) args[newName] = args[oldName];
    delete args[oldName];
  }
  if (name === "shell" || name === "bash") {
    if (typeof args.background === "boolean") args.background = args.background ? "always" : "never";
    if (args.timeoutMs === 0) delete args.timeoutMs;
  }
  if (name === "edit") delete args.replaceAll;
  return args;
}

export function translateZenToolCall(call: NativeToolCall, tools: readonly ToolDefinition[]): NativeToolCall {
  const name = zenToolName(call.name, tools);
  if (name === call.name) return call;
  if (call.args._parseError) return { ...call, name };
  const legacy = sanitizeToolName(call.name);
  const args = legacy === "shell" || legacy === "bash" || legacy === "edit"
    ? legacyToolArgs(legacy, call.args)
    : call.args;
  return { ...call, name, args, rawArguments: JSON.stringify(args) };
}

export function translateZenToolHistory(messages: readonly ChatMessage[], tools: readonly ToolDefinition[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === "tool" && message.name) return { ...message, name: zenToolName(message.name, tools) };
    if (!message.toolCalls?.length) return message;
    return { ...message, toolCalls: message.toolCalls.map((call) => translateZenToolCall(call, tools)) };
  });
}

export function translateZenToolResult(result: CompletionResult, tools: readonly ToolDefinition[]): CompletionResult {
  if (!result.toolCalls?.length) return result;
  return { ...result, toolCalls: result.toolCalls.map((call) => translateZenToolCall(call, tools)) };
}
