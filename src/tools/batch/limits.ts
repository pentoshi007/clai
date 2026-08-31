import { INTERACTIVE_SESSION_TOOL_NAMES } from "../interactive-session-tools.js";
export const BATCH_DEFAULT_CONCURRENCY = 3;
export const BATCH_FORBIDDEN_TOOLS = new Set([
  "tool.batch",
  ...INTERACTIVE_SESSION_TOOL_NAMES,
  "plan.create",
  "task.move",
  "task.read",
  "task.update",
  "agent.handoff",
  "instructions.record",
]);
export const BATCH_HARD_TIMEOUT_MS = 40_000;
export const BATCH_HEARTBEAT_MS = 5_000;
export const BATCH_MAX_CALLS = 20;
export const BATCH_MAX_CONCURRENCY = 6;
