import type { ToolCall, ToolResult } from "../../../types.js";
import {
  finishEngagementAction,
  recordEngagementCheckpoint,
  reconcileEngagementJob,
  saveEngagement,
  type EngagementActionRecord,
  type EngagementGraph,
} from "../../../store/engagement.js";

const OBSERVATION_LIMIT = 16_000;

const isScannerLead = (call: ToolCall): boolean =>
  call.name === "net.scan" || call.name.startsWith("pentest.");

export const recordEngagementOutcome = async (
  graph: EngagementGraph,
  record: EngagementActionRecord,
  input: {
    readonly call: ToolCall;
    readonly result: ToolResult;
    readonly artifactPath: string | undefined;
  },
): Promise<void> => {
  const backgroundJob = input.result.backgroundJob;
  if (backgroundJob) {
    const checkpoint = {
      jobId: backgroundJob.id,
      status: backgroundJob.status,
      artifactPath: backgroundJob.artifactPath,
      offset: backgroundJob.nextOffset ?? 0,
      observation: input.result.output.slice(0, OBSERVATION_LIMIT),
    };
    const reconciled = reconcileEngagementJob(graph, checkpoint);
    if (!reconciled || reconciled.actionId !== record.id) {
      recordEngagementCheckpoint(graph, {
        actionId: record.id,
        ...checkpoint,
      });
    }
  } else {
    finishEngagementAction(graph, record.id, {
      ok: input.result.ok,
      observation: input.result.output.slice(0, OBSERVATION_LIMIT),
      ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
      scannerLead: isScannerLead(input.call),
    });
  }
  await saveEngagement(graph);
};
