import { jobManager } from "../jobs.js";
import type { StartJobOptions } from "../jobs.js";
import type { ToolRunOptions } from "../tool-types.js";

export function responderJobOptions(options?: ToolRunOptions): StartJobOptions {
  const responderLeaseId = jobManager.getResponderLeaseId(options?.sessionId);
  return {
    ...(options?.sessionId ? { ownerSessionId: options.sessionId } : {}),
    ...(options?.taskId ? { taskId: options.taskId } : {}),
    ...(options?.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
    ...(options?.delegationId ? { delegationId: options.delegationId } : {}),
    ...(options?.wakeOnCompletion !== undefined
      ? { wakeOnCompletion: options.wakeOnCompletion }
      : {}),
    ...(options?.monitor !== undefined ? { monitor: options.monitor } : {}),
    ...(responderLeaseId ? { responderLeaseId } : {}),
  };
}
