import type { McpRuntime } from "../mcp/runtime.js";
import type {
  ChatMessage,
  ChatImage,
  Mode,
  ProviderId,
  ToolCall,
} from "../types.js";
import type { AgentEvent } from "../agent/events.js";
import type { TurnOutcome } from "../agent/turn-outcome.js";
import {
  runAgentTurn,
  parseToolCall,
  createSessionPolicy,
  type ConfirmPort,
  type SessionPolicy,
} from "../agent/runner.js";

export interface AgentOptions {
  mcp?: McpRuntime | undefined;
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  signal?: AbortSignal | undefined;
  requestSecret?: ((request: { title: string; prompt: string }) => Promise<string | undefined>) | undefined;
  session?: SessionPolicy | undefined;
  images?: ChatImage[] | undefined;
  visionProven?: boolean | undefined;
  onToolStart?: ((call: ToolCall) => void) | undefined;
  onToolResult?:
    | ((
        call: ToolCall,
        result: { ok: boolean; output: string; exitCode?: number | undefined },
      ) => void)
    | undefined;
  onEvent?: ((event: AgentEvent) => void) | undefined;
  onOutcome?: ((outcome: TurnOutcome) => void) | undefined;
  onMessages?: ((messages: ChatMessage[]) => void) | undefined;
  confirm?: ConfirmPort | undefined;
  mode?: Mode | undefined;
  displayPrompt?: string | null | undefined;
}

export { parseToolCall, createSessionPolicy };
export type { SessionPolicy };

export async function runAgent(
  prompt: string,
  options: AgentOptions = {},
): Promise<string> {
  let finalAnswer: string | undefined;
  const outcome = await runAgentTurn(prompt, {
    ...options,
    onEvent: (event) => {
      if (event.type === "turn-end") finalAnswer = event.finalAnswer;
      options.onEvent?.(event);
    },
  });
  return finalAnswer ?? outcome.answer;
}
