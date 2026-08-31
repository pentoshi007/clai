import { parseCancelOnFailField, resolveBatchCallId } from "../batch-fail-policy.js";
import { externalToolNames, isExternalToolName } from "../external-tools.js";
import { knownToolNames, normalizeBatchToolName, toolRegistry } from "../registry.js";
import { BATCH_FORBIDDEN_TOOLS, BATCH_MAX_CALLS } from "./limits.js";

interface BatchCallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
  cancelOnFail: string[];
  index0: number;
}

export function parseBatchCalls(value: unknown): BatchCallSpec[] {
  if (!Array.isArray(value)) {
    throw new Error("tool.batch expects { calls: [{name, args}, ...] }");
  }
  if (value.length === 0) {
    throw new Error("tool.batch requires at least one call");
  }
  if (value.length > BATCH_MAX_CALLS) {
    throw new Error(
      `tool.batch accepts at most ${BATCH_MAX_CALLS} calls per invocation`,
    );
  }
  const seenIds = new Set<string>();
  return value.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      typeof (entry as { args?: unknown }).args !== "object" ||
      (entry as { args?: unknown }).args === null
    ) {
      throw new Error(
        `tool.batch call #${index} must be { name: string, args: object }`,
      );
    }
    const rec = entry as Record<string, unknown>;
    const rawName = rec.name as string;
    const args = rec.args as Record<string, unknown>;
    const name = normalizeBatchToolName(rawName);
    if (BATCH_FORBIDDEN_TOOLS.has(name)) {
      throw new Error(
        `tool.batch refuses to run "${rawName}" — ${name} cannot be nested inside a batch`,
      );
    }
    if (!toolRegistry[name] && !isExternalToolName(name)) {
      throw new Error(
        `tool.batch refuses unknown tool "${rawName}"` +
          (name !== rawName ? ` (normalized to "${name}")` : "") +
          `. Available tools: ${knownToolNames().join(", ")}` +
          (externalToolNames().length > 0
            ? `, ${[...externalToolNames()].sort().join(", ")}`
            : ""),
      );
    }
    const id = resolveBatchCallId(rec, index, seenIds);
    const cancelOnFail = parseCancelOnFailField(rec, `call #${index}`);
    return { id, name, args, cancelOnFail, index0: index };
  });
}

/** Combine parent abort + policy abort into one signal for children. */
export function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const anyFn = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anyFn === "function") {
    return anyFn([a, b]);
  }
  const ac = new AbortController();
  const forward = (): void => {
    if (!ac.signal.aborted) ac.abort();
  };
  if (a.aborted || b.aborted) {
    ac.abort();
    return ac.signal;
  }
  a.addEventListener("abort", forward, { once: true });
  b.addEventListener("abort", forward, { once: true });
  return ac.signal;
}

export async function runWithLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const runners: Promise<void>[] = [];
  for (let n = 0; n < Math.min(limit, queue.length); n += 1) {
    runners.push(
      (async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) break;
          await worker(next.item, next.index);
        }
      })(),
    );
  }
  await Promise.all(runners);
}
