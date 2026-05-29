import type { ChatMessage, ChatImage, ProviderId, ToolCall } from "../types.js";
import {
  runAgentLoop,
  parseToolCall,
  createSessionPolicy,
  type SessionPolicy,
} from "../agent/runner.js";

export interface AgentOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  signal?: AbortSignal | undefined;
  session?: SessionPolicy | undefined;
  images?: ChatImage[] | undefined;
  onToolStart?: ((call: ToolCall) => void) | undefined;
  onToolResult?:
    | ((
        call: ToolCall,
        result: { ok: boolean; output: string; exitCode?: number | undefined },
      ) => void)
    | undefined;
}

export { parseToolCall, createSessionPolicy };
export type { SessionPolicy };

export async function runAgent(
  prompt: string,
  options: AgentOptions = {},
): Promise<string> {
  return runAgentLoop(prompt, options);
}
