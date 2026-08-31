import type { AgentEvent } from "../events.js";
import type {
  NativeToolCall,
  ToolCall,
  ToolResult,
} from "../../types.js";

export interface TurnEventPort {
  readonly emit: (event: AgentEvent) => void;
}

export interface TurnOutputState {
  visibleCommitted: boolean;
}

export type SingleToolResult = {
  ok: boolean;
  call: ToolCall;
  result: ToolResult;
  contextOutput: string;
  lastAnswer?: string | undefined;
  aborted?: boolean | undefined;
  suppressedRepeat?: boolean | undefined;
  blockOrCancel?: boolean | undefined;
};

export interface BoundCall {
  index: number;
  id: string;
  call: ToolCall;
  native: NativeToolCall;
  wireId?: string | undefined;
}
