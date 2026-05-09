import type { ChatMessage, ProviderId, ToolCall } from "../types.js";
import { runAgentLoop, parseToolCall } from "../agent/runner.js";

export interface AgentOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  signal?: AbortSignal | undefined;
  onToolStart?: ((call: ToolCall) => void) | undefined;
  onToolResult?:
    | ((
        call: ToolCall,
        result: { ok: boolean; output: string; exitCode?: number | undefined },
      ) => void)
    | undefined;
}

export { parseToolCall };

export async function runAgent(
  prompt: string,
  options: AgentOptions = {},
): Promise<string> {
  return runAgentLoop(prompt, options);
}
