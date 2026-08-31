import type { ToolCall, ToolResult } from "../../../types.js";
import type { SessionPolicy } from "../../session-policy.js";
import type { ConfirmPort } from "../../confirm-port.js";
import type { LoopGuard } from "../../loop-guard.js";
import type { PromptMutex } from "../tool-call-preparation.js";
import { confirmToolExecution } from "../../confirm-port.js";
import { restoreInteractiveStdin } from "../../../noninteractive/readline-prompts.js";

export interface McpAgentPortsInput {
  readonly askMode: boolean;
  readonly autoConfirm: boolean;
  readonly session: SessionPolicy;
  readonly confirmPort: ConfirmPort;
  readonly promptMutex: PromptMutex;
  readonly loopGuard: LoopGuard;
  readonly step: () => number;
  readonly isPrinted: (toolEventId: string) => boolean;
  readonly markPrinted: (toolEventId: string) => void;
  readonly writeToolCall: (toolEventId: string, call: ToolCall) => void;
  readonly writeToolOutput: (
    toolEventId: string,
    chunk: string,
    options?: { replace?: boolean },
  ) => void;
  readonly emitToolResult: (
    toolEventId: string,
    result: ToolResult,
    contextOutput: string,
    artifactPath?: string,
  ) => void;
}

export const buildMcpAgentToolPorts = (input: McpAgentPortsInput) => ({
  askMode: input.askMode,
  showCall: (toolEventId: string, call: ToolCall): void => {
    if (input.isPrinted(toolEventId)) return;
    input.writeToolCall(toolEventId, call);
    input.markPrinted(toolEventId);
  },
  writeOutput: (toolEventId: string, chunk: string) =>
    input.writeToolOutput(toolEventId, chunk, { replace: true }),
  emitResult: input.emitToolResult,
  confirm: async (call: ToolCall): Promise<boolean> => {
    const releasePrompt = await input.promptMutex.acquire();
    try {
      const confirmed = await confirmToolExecution(
        call,
        input.autoConfirm,
        input.session,
        input.confirmPort,
      );
      restoreInteractiveStdin();
      return confirmed;
    } finally {
      releasePrompt();
    }
  },
  recordAttempt: (call: ToolCall, ok: boolean, output: string) =>
    input.loopGuard.recordAttempt(
      input.step(),
      call.name,
      call.args,
      ok,
      0,
      output,
    ),
});
