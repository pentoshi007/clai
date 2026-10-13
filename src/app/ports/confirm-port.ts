import type { ToolCall } from "../../types.js";

export interface ToolConfirmationContext {
  readonly reason: string;
}

export interface ConfirmationPort {
  confirmTool(call: ToolCall, context?: ToolConfirmationContext): Promise<boolean>;
  confirmPentest(call?: ToolCall): Promise<boolean>;
  confirmAgentSwitch?(info: {
    reason: string;
    tools: string[];
  }): Promise<boolean>;
}
