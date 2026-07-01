import type { ChatMessage, ChatImage, ProviderId, ToolCall } from "../types.js";
import type { AgentEvent } from "../agent/events.js";
import {
  runAgentLoop,
  parseToolCall,
  createSessionPolicy,
  type ConfirmPort,
  type SessionPolicy,
} from "../agent/runner.js";

export interface AgentOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  signal?: AbortSignal | undefined;
  requestSecret?: ((request: { title: string; prompt: string }) => Promise<string | undefined>) | undefined;
  session?: SessionPolicy | undefined;
  images?: ChatImage[] | undefined;
  onToolStart?: ((call: ToolCall) => void) | undefined;
  onToolResult?:
    | ((
        call: ToolCall,
        result: { ok: boolean; output: string; exitCode?: number | undefined },
      ) => void)
    | undefined;
  onEvent?: ((event: AgentEvent) => void) | undefined;
  onMessages?: ((messages: ChatMessage[]) => void) | undefined;
  confirm?: ConfirmPort | undefined;
}

export { parseToolCall, createSessionPolicy };
export type { SessionPolicy };

export async function runAgent(
  prompt: string,
  options: AgentOptions = {},
): Promise<string> {
  return runAgentLoop(prompt, options);
}
