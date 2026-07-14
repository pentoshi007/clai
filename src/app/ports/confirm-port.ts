import type { ToolCall } from "../../types.js";

/**
 * Typed async confirmation surface (CORE-002). The UI implements this; the
 * agent never reads the terminal directly. Structurally identical to the
 * legacy `ConfirmPort` in src/agent, so a v2 implementation is accepted by
 * `runAgentLoop` without adaptation. Optional methods let minimal ports omit
 * flows they never trigger.
 */
export interface ConfirmationPort {
  confirmTool(call: ToolCall): Promise<boolean>;
  confirmPentest(): Promise<boolean>;
  confirmContinue?(steps: number): Promise<boolean>;
  confirmAgentSwitch?(info: {
    reason: string;
    tools: string[];
  }): Promise<boolean>;
}
