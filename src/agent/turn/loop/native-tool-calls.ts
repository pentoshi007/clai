import type { NativeToolCall, ToolCall } from "../../../types.js";
import { normalizeToolCall } from "../../../tools/registry.js";
import type { StreamDeferredToolCall } from "./stream-session.js";

export interface NativeCardPorts {
  readonly deferredToolCalls: StreamDeferredToolCall[];
  readonly callIds: string[];
  readonly allocateEventId: () => string;
  readonly markPrinted: (eventId: string) => void;
}

const PLACEHOLDER_NAME = "…";

const appendCards = (
  ports: NativeCardPorts,
  calls: readonly NativeToolCall[],
): void => {
  for (let index = 0; index < calls.length; index += 1) {
    const native = calls[index]!;
    const call = normalizeToolCall({ name: native.name, args: native.args });
    const eventId = ports.allocateEventId();
    ports.callIds[index] = eventId;
    ports.markPrinted(eventId);
    ports.deferredToolCalls.push({ eventId, call, shown: false });
  }
};

const reconcileCards = (
  ports: NativeCardPorts,
  calls: readonly NativeToolCall[],
): void => {
  for (let index = 0; index < calls.length; index += 1) {
    const native = calls[index]!;
    const call = normalizeToolCall({ name: native.name, args: native.args });
    const existing = ports.deferredToolCalls[index];
    if (existing && existing.call.name !== PLACEHOLDER_NAME) {
      ports.callIds[index] = existing.eventId;
      existing.call = call;
      continue;
    }
    const eventId = existing?.eventId ?? ports.allocateEventId();
    ports.callIds[index] = eventId;
    ports.markPrinted(eventId);
    const entry: StreamDeferredToolCall = {
      eventId,
      call,
      shown: existing?.shown ?? false,
    };
    if (existing) ports.deferredToolCalls[index] = entry;
    else ports.deferredToolCalls.push(entry);
  }
};

export const syncNativeToolCallCards = (
  ports: NativeCardPorts,
  calls: readonly NativeToolCall[],
): void => {
  if (calls.length === 0) return;
  if (ports.deferredToolCalls.length === 0) appendCards(ports, calls);
  else reconcileCards(ports, calls);
};

export const firstNativeToolCall = (
  calls: readonly NativeToolCall[],
): ToolCall | undefined => {
  const first = calls[0];
  if (!first) return undefined;
  if (first.args?._parseError) {
    return {
      name: first.name || "unknown",
      args: { __nativeParseError: true, _raw: first.args._raw },
    };
  }
  return normalizeToolCall({ name: first.name, args: first.args });
};
