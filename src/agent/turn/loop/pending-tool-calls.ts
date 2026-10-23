import type { NativeToolCall, ToolCallStreamDelta } from "../../../types.js";
import { fromWireName } from "../../../llm/tool-protocol.js";
import { canonicalizeTurnCall, type ToolNameCanonicalizer } from "./canonicalize-turn-call.js";

interface PendingToolCall {
  readonly eventId: string;
  name: string;
  wireId?: string | undefined;
  status: string;
}

export interface PendingToolCallPorts {
  readonly nextToolEventId: () => string;
  readonly writePendingToolCall: (id: string, name: string) => void;
  readonly writeToolBlocked: (id: string, name: string, reason: string) => void;
  readonly mcpRuntime?: ToolNameCanonicalizer | undefined;
}

const toolCallStatus = (name: string, bytes = 0): string =>
  bytes >= 4096 ? `${name} (${Math.round(bytes / 1024)}KB args)` : name;

export function createPendingToolCalls(ports: PendingToolCallPorts, callIds: string[]) {
  const pending = new Map<number, PendingToolCall>();
  const names = new Map<number, string>();
  const wireIds = new Map<number, string>();

  function observe(delta: ToolCallStreamDelta): { status: string; changed: boolean } | undefined {
    if (!Number.isInteger(delta.index) || delta.index < 0) return undefined;
    if (delta.id) wireIds.set(delta.index, delta.id);
    const rawName = delta.name || names.get(delta.index);
    if (!rawName) return undefined;
    const decoded = fromWireName(rawName) ?? rawName;
    const name = canonicalizeTurnCall({ name: decoded, args: {} }, ports.mcpRuntime).name;
    names.set(delta.index, name);
    let entry = pending.get(delta.index);
    const status = toolCallStatus(name, delta.argumentsBytes);
    const changed = entry?.status !== status;
    if (!entry) {
      entry = { eventId: ports.nextToolEventId(), name, status };
      pending.set(delta.index, entry);
      ports.writePendingToolCall(entry.eventId, name);
    } else if (entry.name !== name) {
      entry.name = name;
      ports.writePendingToolCall(entry.eventId, name);
    }
    entry.wireId = wireIds.get(delta.index);
    entry.status = status;
    return { status, changed };
  }

  function finish(calls: readonly NativeToolCall[] = []): void {
    const entries = [...pending].sort(([left], [right]) => left - right);
    const used = new Set<number>();
    for (const [ordinal, [, entry]] of entries.entries()) {
      const index = entry.wireId ? calls.findIndex(call => call.id === entry.wireId) : ordinal;
      if (index >= 0 && index < calls.length && !used.has(index)) {
        callIds[index] = entry.eventId;
        used.add(index);
      } else {
        ports.writeToolBlocked(entry.eventId, entry.name, "The provider did not complete this tool call. Nothing ran.");
      }
    }
    pending.clear();
    wireIds.clear();
  }

  return { names, observe, finish };
}
