
export const QUIET_META_TOOL_NAMES = new Set([
  "plan.create",
  "task.add",
  "task.move",
  "job.read",
  "task.read",
  "task.update",
]);

export function isQuietMetaTool(name: string): boolean {
  return name === "plan.create" || name === "job.read" || name.startsWith("task.");
}

export function shouldHideQuietMetaToolInChat(
  name: string,
  status: string,
): boolean {
  if (!isQuietMetaTool(name)) return false;
  if (name.startsWith("task.")) return true;
  return status !== "failed" && status !== "blocked";
}
