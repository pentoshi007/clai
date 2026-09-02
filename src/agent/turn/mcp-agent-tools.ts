import type { ToolCall, ToolResult } from "../../types.js";
import type { McpRuntime } from "../../mcp/runtime.js";
import type { SingleToolResult } from "./contracts.js";

export interface McpAgentToolPorts {
  readonly askMode: boolean;
  readonly showCall: (toolEventId: string, call: ToolCall) => void;
  readonly writeOutput: (toolEventId: string, chunk: string) => void;
  readonly emitResult: (
    toolEventId: string,
    result: ToolResult,
    contextOutput: string,
  ) => void;
  readonly confirm: (call: ToolCall) => Promise<boolean>;
  readonly recordAttempt: (call: ToolCall, ok: boolean, output: string) => void;
}

export const mcpAgentToolTarget = (
  args: Record<string, unknown>,
): string | readonly string[] | undefined => {
  if (Array.isArray(args.servers)) {
    return args.servers.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  if (typeof args.server === "string") return args.server;
  return undefined;
};

export const runMcpAgentTool = async (
  mcp: McpRuntime,
  call: ToolCall,
): Promise<ToolResult> => {
  const args = call.args ?? {};
  if (call.name === "mcp.list") return mcp.agentList();
  if (call.name === "mcp.tools") {
    return mcp.agentTools(
      typeof args.server === "string" ? args.server : undefined,
    );
  }
  if (call.name === "mcp.enable") return mcp.agentEnable(mcpAgentToolTarget(args));
  if (call.name === "mcp.connect") {
    return mcp.agentConnect(typeof args.server === "string" ? args.server : "");
  }
  return mcp.agentLogin(typeof args.server === "string" ? args.server : "");
};

export const mcpAgentOutput = (call: ToolCall, result: ToolResult): string => {
  const text = result.output.trim();
  if (text.length > 0) return text;
  return result.ok
    ? `${call.name} completed successfully with no textual output.`
    : `${call.name} failed with no textual output (exit ${result.exitCode ?? 1}).`;
};

export const isReadOnlyMcpAgentTool = (call: ToolCall): boolean =>
  call.name === "mcp.list" || call.name === "mcp.tools";

const failCall = (
  ports: McpAgentToolPorts,
  toolEventId: string,
  call: ToolCall,
  reason: string,
  cancelled = false,
): SingleToolResult => {
  ports.showCall(toolEventId, call);
  const result = { ok: false, output: reason, exitCode: 1 };
  const body = cancelled ? `cancelled: ${reason}` : reason;
  ports.writeOutput(toolEventId, `${body}\n`);
  ports.emitResult(toolEventId, result, reason);
  return {
    ok: false,
    call,
    result,
    contextOutput: reason,
    ...(cancelled ? { blockOrCancel: true } : {}),
  };
};

const execute = async (
  ports: McpAgentToolPorts,
  runtime: McpRuntime,
  call: ToolCall,
  toolEventId: string,
): Promise<SingleToolResult> => {
  const readOnly = isReadOnlyMcpAgentTool(call);
  if (!readOnly && ports.askMode) {
    return failCall(
      ports,
      toolEventId,
      call,
      `${call.name} is not available in ask mode because it changes MCP session state. Switch to agent mode.`,
    );
  }
  if (!readOnly && !(await ports.confirm(call))) {
    return failCall(ports, toolEventId, call, "Cancelled.", true);
  }
  ports.showCall(toolEventId, call);
  const result = await runMcpAgentTool(runtime, call);
  const shown = mcpAgentOutput(call, result);
  ports.recordAttempt(call, result.ok, shown);
  ports.writeOutput(toolEventId, `${shown}\n`);
  ports.emitResult(toolEventId, { ...result, output: shown }, shown);
  return {
    ok: result.ok,
    call,
    result: { ...result, output: shown },
    contextOutput: shown,
  };
};

export const createMcpAgentToolExecutor =
  (ports: McpAgentToolPorts) =>
  (
    runtime: McpRuntime,
    call: ToolCall,
    toolEventId: string,
  ): Promise<SingleToolResult> =>
    execute(ports, runtime, call, toolEventId);

export const createMcpAgentCallFailure =
  (ports: McpAgentToolPorts) =>
  (
    toolEventId: string,
    call: ToolCall,
    reason: string,
    cancelled = false,
  ): SingleToolResult =>
    failCall(ports, toolEventId, call, reason, cancelled);
