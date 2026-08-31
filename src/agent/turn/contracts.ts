import type { AgentEvent } from "../events.js";

export interface TurnEventPort {
  readonly emit: (event: AgentEvent) => void;
}

export interface TurnOutputState {
  visibleCommitted: boolean;
}
