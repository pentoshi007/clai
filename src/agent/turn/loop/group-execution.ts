import type { ToolCall } from "../../../types.js";
import type { BoundCall, SingleToolResult } from "../contracts.js";
import type { RoundState } from "./round-state.js";
import type { RecordedToolResult } from "./round-recorder.js";

export interface GroupExecutionPorts {
  readonly round: RoundState;
  readonly boundFor: (call: ToolCall) => BoundCall | undefined;
  readonly eventIdFor: (bound: BoundCall) => string;
  readonly replay: (
    bound: BoundCall,
    uiId: string,
  ) => RecordedToolResult | undefined;
  readonly execute: (call: ToolCall, uiId: string) => Promise<SingleToolResult>;
  readonly record: (bound: BoundCall, res: RecordedToolResult) => void;
  readonly remember: (bound: BoundCall, res: RecordedToolResult) => void;
}

const runOne = async (
  ports: GroupExecutionPorts,
  call: ToolCall,
): Promise<void> => {
  const bound = ports.boundFor(call);
  if (!bound) return;
  const uiId = ports.eventIdFor(bound);
  const replayed = ports.replay(bound, uiId);
  if (replayed) {
    ports.record(bound, replayed);
    return;
  }
  const res = await ports.execute(call, uiId);
  ports.record(bound, res);
  ports.remember(bound, res);
};

const runConcurrent = async (
  ports: GroupExecutionPorts,
  group: readonly ToolCall[],
): Promise<void> => {
  const bounds: BoundCall[] = [];
  const uiIds: string[] = [];
  for (const call of group) {
    const bound = ports.boundFor(call);
    if (!bound) continue;
    bounds.push(bound);
    uiIds.push(ports.eventIdFor(bound));
  }
  const results = await Promise.all(
    bounds.map((bound, index) => {
      const replayed = ports.replay(bound, uiIds[index]!);
      return replayed ?? ports.execute(bound.call, uiIds[index]!);
    }),
  );
  for (let index = 0; index < results.length; index += 1) {
    ports.record(bounds[index]!, results[index]!);
    ports.remember(bounds[index]!, results[index]!);
  }
};

export const executeToolGroups = async (
  ports: GroupExecutionPorts,
  groups: readonly (readonly ToolCall[])[],
): Promise<void> => {
  for (const group of groups) {
    if (ports.round.aborted || ports.round.awaitingPlanApproval) break;
    if (group.length === 1) await runOne(ports, group[0]!);
    else await runConcurrent(ports, group);
  }
};
