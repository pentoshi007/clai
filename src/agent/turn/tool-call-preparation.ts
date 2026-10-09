import { stat } from "node:fs/promises";
import type { ToolCall, ToolResult } from "../../types.js";
import type { SalvagedWrite } from "../tool-call-parser.js";
import {
  elidedStubReuseMessage,
  findElidedStubArg,
} from "../../agent/message-slim.js";
import { resolveFsToolPath } from "../../tools/fs.js";
import type { SingleToolResult } from "./contracts.js";
import type { McpRuntime } from "../../mcp/runtime.js";

export interface InvalidToolCall {
  readonly reason: string;
  readonly result: ToolResult;
}

export const invalidToolCall = (
  call: ToolCall,
  mcpRuntime?: McpRuntime,
): InvalidToolCall | undefined => {
  if (call.args?.__nativeParseError) {
    const raw = String(call.args._raw ?? "").slice(0, 200);
    const reason =
      "Tool call arguments were not valid JSON (truncated or malformed). " +
      "Retry with smaller content, or use fs.writeMany / fs.append continuation. " +
      (raw ? `Partial: ${raw}` : "");
    return { reason, result: { ok: false, output: reason, exitCode: 1 } };
  }
  if (call.name === "mcp.call") {
    const name = call.args.name;
    const args = call.args.arguments;
    let detail: string;
    if (typeof name !== "string" || !name.trim()) {
      detail = 'The "name" field must be the exact MCP tool name returned by mcp.tools.';
    } else if (!args || typeof args !== "object" || Array.isArray(args)) {
      detail = 'The "arguments" field must be a JSON object matching the tool schema.';
    } else if (mcpRuntime) {
      const tool = mcpRuntime.getTool(name);
      detail = tool
        ? `Use the exact target name ${JSON.stringify(tool.canonicalName)} with the same arguments.`
        : mcpRuntime.unavailableToolMessage(name);
    } else {
      detail = "The MCP runtime is unavailable for this turn.";
    }
    const reason =
      "mcp.call requires an active MCP tool's exact dotted or wire name and an arguments object. " + detail;
    return { reason, result: { ok: false, output: reason, exitCode: 1 } };
  }
  const elidedStub = findElidedStubArg(call.args);
  if (!elidedStub) return undefined;
  const reason = elidedStubReuseMessage(elidedStub.key);
  return { reason, result: { ok: false, output: reason, exitCode: 1 } };
};

export interface PromptMutex {
  readonly acquire: () => Promise<() => void>;
}

export const createPromptMutex = (): PromptMutex => {
  let queue: Promise<void> = Promise.resolve();
  return {
    acquire: async () => {
      let release = (): void => undefined;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const current = queue;
      queue = current.then(() => next);
      await current;
      return release;
    },
  };
};

export const salvagedWriteCall = (salvaged: SalvagedWrite): ToolCall => {
  const args: Record<string, unknown> = {
    path: salvaged.path,
    content: salvaged.content,
  };
  if (salvaged.operation === "append") {
    args.position = "end";
    if (typeof salvaged.expectedPriorBytes === "number") {
      args.expectedPriorBytes = salvaged.expectedPriorBytes;
    }
  }
  return {
    name: salvaged.operation === "append" ? "fs.append" : "fs.write",
    args,
  };
};

export interface SalvagedWriteReceipt {
  readonly ok: boolean;
  readonly cancelled: boolean;
  readonly output: string;
  readonly bytesOnDisk: number;
}

export const readSalvagedWriteReceipt = async (
  salvaged: SalvagedWrite,
  executed: SingleToolResult,
): Promise<SalvagedWriteReceipt> => {
  const ok = executed.ok && executed.result.ok;
  let bytesOnDisk = Buffer.byteLength(salvaged.content, "utf8");
  if (ok) {
    try {
      const stats = await stat(resolveFsToolPath(salvaged.path));
      bytesOnDisk = stats.size;
    } catch {
    }
  }
  return {
    ok,
    cancelled: Boolean(executed.blockOrCancel),
    output: executed.result.output,
    bytesOnDisk,
  };
};
