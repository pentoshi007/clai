import { TURN_END_TOOL_NAME } from "../../tools/turn-end.js";
import { USER_ASK_TOOL_NAME } from "../../tools/user-ask.js";

export const QUIET_META_TOOL_NAMES = new Set([
  "plan.create",
  "plan.update",
  "task.add",
  "task.move",
  "job.read",
  "task.update",
  TURN_END_TOOL_NAME,
  USER_ASK_TOOL_NAME,
]);

const ALWAYS_HIDDEN_META_TOOL_NAMES: ReadonlySet<string> = new Set([
  TURN_END_TOOL_NAME,
]);

export function isQuietMetaTool(name: string): boolean {
  return QUIET_META_TOOL_NAMES.has(name) || name.startsWith("task.");
}

export function shouldHideQuietMetaToolInChat(
  name: string,
  status: string,
): boolean {
  if (!isQuietMetaTool(name)) return false;
  if (name.startsWith("task.") || ALWAYS_HIDDEN_META_TOOL_NAMES.has(name)) return true;
  return status !== "failed" && status !== "blocked";
}
