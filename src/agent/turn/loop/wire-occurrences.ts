import type { ToolCall, ToolResult } from "../../../types.js";

export interface ExecutedOccurrence {
  readonly call: ToolCall;
  readonly result: ToolResult;
  readonly contextOutput: string;
  readonly ok: boolean;
}

export interface ReplayedOccurrence extends ExecutedOccurrence {
  readonly suppressedRepeat: true;
}

export interface WireOccurrencePorts {
  readonly isPrinted: (eventId: string) => boolean;
  readonly writeToolCall: (eventId: string, call: ToolCall) => void;
  readonly markPrinted: (eventId: string) => void;
  readonly emitToolStart: (eventId: string) => void;
  readonly writeToolOutput: (eventId: string, chunk: string) => void;
  readonly emitToolResult: (
    eventId: string,
    result: ToolResult,
    contextOutput: string,
  ) => void;
  readonly signature: (call: ToolCall) => string;
  readonly changeEpoch: () => number;
}

export const DUPLICATE_WIRE_CALL_NOTICE =
  "This exact provider tool call already executed this turn. " +
  "The earlier result is replayed below; the tool did not run again.";

export interface WireOccurrenceLedger {
  readonly replay: (
    wireId: string | undefined,
    call: ToolCall,
    eventId: string,
  ) => ReplayedOccurrence | undefined;
  readonly remember: (
    wireId: string | undefined,
    call: ToolCall,
    executed: {
      call: ToolCall;
      result: ToolResult;
      contextOutput: string;
      ok: boolean;
      aborted?: boolean | undefined;
      suppressedRepeat?: boolean | undefined;
    },
  ) => void;
  readonly settleRound: () => void;
}

interface RememberedOccurrence extends ExecutedOccurrence {
  readonly signature: string;
  readonly epoch: number;
}

export const createWireOccurrenceLedger = (
  ports: WireOccurrencePorts,
): WireOccurrenceLedger => {
  const executed = new Map<string, RememberedOccurrence>();
  const rememberedThisRound = new Set<string>();
  return {
    replay: (wireId, call, eventId) => {
      const prior = wireId ? executed.get(wireId) : undefined;
      if (
        !prior ||
        prior.signature !== ports.signature(call) ||
        prior.epoch !== ports.changeEpoch()
      ) {
        return undefined;
      }
      const output = `${DUPLICATE_WIRE_CALL_NOTICE}\n\n${prior.contextOutput}`;
      const result: ToolResult = {
        ...prior.result,
        output,
        suppressedRepeat: true,
      };
      if (!ports.isPrinted(eventId)) {
        ports.writeToolCall(eventId, call);
        ports.markPrinted(eventId);
        ports.emitToolStart(eventId);
      }
      ports.writeToolOutput(
        eventId,
        output.endsWith("\n") ? output : `${output}\n`,
      );
      ports.emitToolResult(eventId, result, output);
      return {
        call,
        result,
        contextOutput: output,
        ok: prior.ok,
        suppressedRepeat: true,
      };
    },
    remember: (wireId, call, result) => {
      if (!wireId) return;
      if (!result.ok || result.aborted || result.suppressedRepeat) return;
      executed.set(wireId, {
        call: result.call,
        result: result.result,
        contextOutput: result.contextOutput,
        ok: result.ok,
        signature: ports.signature(call),
        epoch: ports.changeEpoch(),
      });
      rememberedThisRound.add(wireId);
    },
    settleRound: () => {
      const epoch = ports.changeEpoch();
      for (const wireId of rememberedThisRound) {
        const occurrence = executed.get(wireId);
        if (occurrence) executed.set(wireId, { ...occurrence, epoch });
      }
      rememberedThisRound.clear();
    },
  };
};
