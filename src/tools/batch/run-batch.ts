import { BATCH_SAFE_TOOLS } from "../registry.js";
import {
  BATCH_DEFAULT_CONCURRENCY,
  BATCH_FORBIDDEN_TOOLS,
  BATCH_HARD_TIMEOUT_MS,
  BATCH_HEARTBEAT_MS,
  BATCH_MAX_CALLS,
  BATCH_MAX_CONCURRENCY,
} from "./limits.js";
import { classifyToolCall } from "../../safety/classifier.js";
import { loadScopeForSession } from "../../store/scope.js";
import type { ChatImage, ToolResult } from "../../types.js";
import {
  compileBatchFailMode,
  evaluateCancelTargets,
  formatBatchCancelReason,
  parseBatchFailPolicy,
  parseCancelOnFailField,
  resolveBatchCallId,
} from "../batch-fail-policy.js";
import type { BatchCallFailMeta, BatchFailMode } from "../batch-fail-policy.js";
import {
  externalToolNames,
  isExternalToolName,
  isExternalToolParallelSafe,
} from "../external-tools.js";
import { optionalNumber } from "../handlers/args.js";
import {
  knownToolNames,
  normalizeBatchToolName,
  runToolCall,
  toolRegistry,
} from "../registry.js";
type BatchOutcomeStatus = "ok" | "fail" | "cancelled";
import type { ToolRunOptions } from "../tool-types.js";

interface BatchCallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
  cancelOnFail: string[];
  index0: number;
}

function parseBatchCalls(value: unknown): BatchCallSpec[] {
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
function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
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

async function runWithLimit<T>(
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

interface BatchOutcome {
  index: number;
  id: string;
  name: string;
  status: BatchOutcomeStatus;
  ok: boolean;
  output: string;
  exitCode?: number | undefined;
  error?: string | undefined;
  suppressedRepeat?: boolean | undefined;
  /**
   * Images a child wants the model to look at (image.view). Without this the
   * aggregate result would drop the bytes while still telling the model an
   * image was attached.
   */
  images?: ChatImage[] | undefined;
}

export async function runToolBatch(
  args: Record<string, unknown>,
  options?: ToolRunOptions,
): Promise<ToolResult> {
  const calls = parseBatchCalls(args.calls);
  const knownIds = new Set(calls.map((c) => c.id));
  const callMeta: BatchCallFailMeta[] = calls.map((c) => ({
    id: c.id,
    name: c.name,
    index1: c.index0 + 1,
    cancelOnFail: c.cancelOnFail,
  }));
  const metaById = new Map(callMeta.map((m) => [m.id, m]));
  const failMode: BatchFailMode = compileBatchFailMode(
    parseBatchFailPolicy(args, knownIds),
    callMeta,
    knownIds,
  );

  // Re-classify each child: block always refused; confirm allowed only when
  // the parent turn already confirmed (options.confirmed) so shell/fs mutates
  // cannot sneak past the safety gate as a "safe" batch wrapper.
  const scope = await loadScopeForSession(options?.sessionId).catch(
    () => undefined,
  );
  let needsSerial = false;
  for (const spec of calls) {
    const decision = classifyToolCall(
      { name: spec.name, args: spec.args },
      { scope },
    );
    if (decision.level === "block") {
      throw new Error(`tool.batch refuses ${spec.name}: ${decision.reason}`);
    }
    if (decision.level === "confirm") {
      if (!options?.confirmed) {
        throw new Error(
          `tool.batch refuses ${spec.name}: ${decision.reason} ` +
            `(confirm-level tools need approval — emit them as top-level tools, or re-run the batch after confirm)`,
        );
      }
      needsSerial = true;
    }
    // Non-parallel-safe tools always serialize to avoid racing writes/shells.
    if (
      !BATCH_SAFE_TOOLS.has(spec.name) &&
      !isExternalToolParallelSafe(spec.name)
    ) {
      needsSerial = true;
    }
  }
  const requestedConcurrency = Math.max(
    1,
    Math.min(
      typeof args.concurrency === "number"
        ? Math.floor(args.concurrency)
        : BATCH_DEFAULT_CONCURRENCY,
      BATCH_MAX_CONCURRENCY,
    ),
  );
  // Parallel only when every child is read-only/safe-parallel. Mixed or
  // mutating batches run one-at-a-time in order.
  // Selective/fail-fast policies also force serial so cancel decisions apply
  // before dependents start (deterministic for models).
  if (failMode.kind !== "continue") {
    needsSerial = true;
  }
  const concurrency = needsSerial ? 1 : requestedConcurrency;

  // Local abort that fires on parent cancel OR the batch hard timeout.
  // Children receive this signal so a hung http.fetch/dns cannot pin the UI
  // on "● tool.batch running" forever.
  const batchAc = new AbortController();
  // Policy cancel (on_fail) — separate from user Esc / hard timeout.
  const policyAc = new AbortController();
  const onParentAbort = (): void => {
    if (!batchAc.signal.aborted) batchAc.abort();
  };
  if (options?.signal) {
    if (options.signal.aborted) batchAc.abort();
    else
      options.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const batchTimeoutMs = Math.max(
    1_000,
    Math.min(
      1_800_000,
      optionalNumber(args, "timeoutMs") ?? BATCH_HARD_TIMEOUT_MS,
    ),
  );
  const hardTimer = setTimeout(() => {
    if (!batchAc.signal.aborted) batchAc.abort();
  }, batchTimeoutMs);
  (hardTimer as unknown as { unref?: () => void }).unref?.();

  let finished = 0;
  const failedIds = new Set<string>();
  const cancelledIds = new Set<string>();
  /** id → human reason for policy cancel */
  const cancelReasons = new Map<string, string>();
  let policyCancelCount = 0;

  const tick = (line: string): void => {
    // Heartbeats also reset the runner's 60s "stalled tool" watchdog, which
    // previously aborted silent batches mid-flight and left no tool-result.
    options?.onOutput?.(line.endsWith("\n") ? line : `${line}\n`, "stdout");
  };
  /** Stream a finished child as a nested `── #N` section so the live UI can
   * expand sub-cards with real output (not just "ok" status ticks). */
  const streamSection = (outcome: BatchOutcome): void => {
    const status = outcome.status;
    const head = `── #${outcome.index + 1} ${outcome.name} [${status}${
      outcome.exitCode !== undefined ? ` exit=${outcome.exitCode}` : ""
    }]`;
    const body = outcome.error
      ? `error: ${outcome.error}`
      : (outcome.output ?? "").trim();
    tick(body ? `${head}\n${body}\n\n` : `${head}\n\n`);
  };
  const modeLabel =
    failMode.kind === "continue"
      ? "continue"
      : failMode.kind === "cancel_pending"
        ? "cancel_pending"
        : `rules(${failMode.rules.length})`;
  tick(
    `[batch] starting ${calls.length} call(s), concurrency=${concurrency}, on_fail=${modeLabel}`,
  );
  const heartbeat = setInterval(() => {
    tick(`[batch] still running — ${finished}/${calls.length} finished`);
  }, BATCH_HEARTBEAT_MS);
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  const applyFailPolicy = (justFailedId: string): void => {
    failedIds.add(justFailedId);
    const targets = evaluateCancelTargets(
      failMode,
      failedIds,
      calls.map((c) => c.id),
    );
    if (targets.size === 0) return;
    const triggerList = [...failedIds];
    const reason = formatBatchCancelReason(triggerList, metaById);
    let newly = 0;
    for (const id of targets) {
      if (cancelledIds.has(id)) continue;
      // Never mark the just-failed id as cancelled (it has a real outcome).
      if (failedIds.has(id)) continue;
      const idx = calls.findIndex((c) => c.id === id);
      if (idx < 0) continue;
      // Already finished with a result — leave it.
      if (outcomes[idx]) continue;
      cancelledIds.add(id);
      cancelReasons.set(id, reason);
      newly += 1;
    }
    if (newly > 0) {
      policyCancelCount += newly;
      if (!policyAc.signal.aborted) policyAc.abort();
      tick(
        `[batch] on_fail cancelled ${newly} call(s) after ${metaById.get(justFailedId)?.name ?? justFailedId} failed`,
      );
    }
  };

  const outcomes: Array<BatchOutcome | undefined> = new Array(calls.length);
  const childSignal = mergeAbortSignals(batchAc.signal, policyAc.signal);

  try {
    await runWithLimit(calls, concurrency, async (spec, index) => {
      // Policy-cancelled before start (or mid-batch after sibling fail).
      if (cancelledIds.has(spec.id) && !outcomes[index]) {
        outcomes[index] = {
          index,
          id: spec.id,
          name: spec.name,
          status: "cancelled",
          ok: false,
          output:
            cancelReasons.get(spec.id) ??
            "Cancelled — not run because a sibling call failed",
          exitCode: 130,
        };
        finished += 1;
        tick(`[batch] #${index + 1} ${spec.name} cancelled`);
        streamSection(outcomes[index]!);
        return;
      }

      if (batchAc.signal.aborted) {
        outcomes[index] = {
          index,
          id: spec.id,
          name: spec.name,
          status: "cancelled",
          ok: false,
          output: "Aborted before execution.",
          exitCode: 130,
        };
        finished += 1;
        streamSection(outcomes[index]!);
        return;
      }

      // Re-check cancel after waiting in the worker queue.
      if (cancelledIds.has(spec.id)) {
        outcomes[index] = {
          index,
          id: spec.id,
          name: spec.name,
          status: "cancelled",
          ok: false,
          output:
            cancelReasons.get(spec.id) ??
            "Cancelled — not run because a sibling call failed",
          exitCode: 130,
        };
        finished += 1;
        tick(`[batch] #${index + 1} ${spec.name} cancelled`);
        streamSection(outcomes[index]!);
        return;
      }

      tick(`[batch] #${index + 1} ${spec.name} starting`);
      try {
        // Lightweight child heartbeats so silent tools (whois) never trip the
        // outer 60s stall watchdog while still running under the batch.
        const childHeartbeat = setInterval(() => {
          tick(`[batch] #${index + 1} ${spec.name} still running…`);
        }, BATCH_HEARTBEAT_MS);
        (childHeartbeat as unknown as { unref?: () => void }).unref?.();
        let result: ToolResult;
        try {
          result = await runToolCall(
            { name: spec.name, args: spec.args },
            // Do not fan full child stdout into the parent spool (parallel
            // interleaving). Settled section bodies are streamed below so the
            // live UI can show expanded nested cards immediately.
            // Forward confirmed so approved mutates inside a batch still run.
            {
              signal: childSignal,
              ...(options?.confirmed !== undefined
                ? { confirmed: options.confirmed }
                : {}),
              ...(options?.requestSecret
                ? { requestSecret: options.requestSecret }
                : {}),
              ...(options?.authorizeNetworkHop
                ? { authorizeNetworkHop: options.authorizeNetworkHop }
                : {}),
              ...(options?.engagementAuthorization
                ? { engagementAuthorization: options.engagementAuthorization }
                : {}),
              ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
              ...(options?.llmProvider
                ? { llmProvider: options.llmProvider }
                : {}),
              ...(options?.llmModel ? { llmModel: options.llmModel } : {}),
              ...(options?.taskId ? { taskId: options.taskId } : {}),
              ...(options?.parentTaskId
                ? { parentTaskId: options.parentTaskId }
                : {}),
              ...(options?.delegationId
                ? { delegationId: options.delegationId }
                : {}),
              ...(options?.wakeOnCompletion !== undefined
                ? { wakeOnCompletion: options.wakeOnCompletion }
                : {}),
              ...(options?.monitor !== undefined
                ? { monitor: options.monitor }
                : {}),
            },
          );
        } finally {
          clearInterval(childHeartbeat);
        }

        // If we were policy-aborted mid-flight and the child looks aborted,
        // surface as cancelled rather than a generic fail when we intended cancel.
        if (
          cancelledIds.has(spec.id) ||
          (policyAc.signal.aborted &&
            !result.ok &&
            (result.exitCode === 130 ||
              /abort|cancel/i.test(result.output ?? "")))
        ) {
          const reason =
            cancelReasons.get(spec.id) ??
            "Cancelled — aborted because a sibling call failed";
          outcomes[index] = {
            index,
            id: spec.id,
            name: spec.name,
            status: "cancelled",
            ok: false,
            output: reason,
            exitCode: 130,
          };
          cancelledIds.add(spec.id);
          tick(`[batch] #${index + 1} ${spec.name} cancelled`);
          streamSection(outcomes[index]!);
        } else if (result.ok) {
          outcomes[index] = {
            index,
            id: spec.id,
            name: spec.name,
            status: "ok",
            ok: true,
            output: result.output,
            exitCode: result.exitCode,
            ...(result.suppressedRepeat ? { suppressedRepeat: true } : {}),
            ...(result.images?.length ? { images: result.images } : {}),
          };
          tick(
            `[batch] #${index + 1} ${spec.name} ok` +
              (result.exitCode !== undefined ? ` exit=${result.exitCode}` : ""),
          );
          streamSection(outcomes[index]!);
        } else {
          outcomes[index] = {
            index,
            id: spec.id,
            name: spec.name,
            status: "fail",
            ok: false,
            output: result.output,
            exitCode: result.exitCode,
            ...(result.suppressedRepeat ? { suppressedRepeat: true } : {}),
          };
          tick(
            `[batch] #${index + 1} ${spec.name} fail` +
              (result.exitCode !== undefined ? ` exit=${result.exitCode}` : ""),
          );
          streamSection(outcomes[index]!);
          applyFailPolicy(spec.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Policy abort while starting/running → cancelled if we marked it.
        if (cancelledIds.has(spec.id) || policyAc.signal.aborted) {
          outcomes[index] = {
            index,
            id: spec.id,
            name: spec.name,
            status: "cancelled",
            ok: false,
            output:
              cancelReasons.get(spec.id) ??
              "Cancelled — aborted because a sibling call failed",
            exitCode: 130,
          };
          cancelledIds.add(spec.id);
          tick(`[batch] #${index + 1} ${spec.name} cancelled`);
          streamSection(outcomes[index]!);
        } else {
          outcomes[index] = {
            index,
            id: spec.id,
            name: spec.name,
            status: "fail",
            ok: false,
            output: "",
            error: message,
          };
          tick(`[batch] #${index + 1} ${spec.name} error: ${message}`);
          streamSection(outcomes[index]!);
          applyFailPolicy(spec.id);
        }
      } finally {
        finished += 1;
      }
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(hardTimer);
    if (options?.signal) {
      options.signal.removeEventListener("abort", onParentAbort);
    }
  }

  // Fill any holes left by a mid-batch abort/timeout/policy cancel so we
  // always emit a complete sectioned body and a tool-result.
  const parentAborted = Boolean(options?.signal?.aborted);
  // Hard timeout aborts batchAc; policy cancel only aborts policyAc.
  const hardTimedOut = batchAc.signal.aborted && !parentAborted;

  for (let i = 0; i < calls.length; i += 1) {
    if (outcomes[i]) continue;
    const spec = calls[i]!;
    if (cancelledIds.has(spec.id) || cancelReasons.has(spec.id)) {
      outcomes[i] = {
        index: i,
        id: spec.id,
        name: spec.name,
        status: "cancelled",
        ok: false,
        output:
          cancelReasons.get(spec.id) ??
          "Cancelled — not run because a sibling call failed",
        exitCode: 130,
      };
      continue;
    }
    if (parentAborted) {
      outcomes[i] = {
        index: i,
        id: spec.id,
        name: spec.name,
        status: "cancelled",
        ok: false,
        output: "Not run — batch aborted.",
        exitCode: 130,
      };
      continue;
    }
    if (hardTimedOut) {
      outcomes[i] = {
        index: i,
        id: spec.id,
        name: spec.name,
        status: "fail",
        ok: false,
        output: `Not run — tool.batch timed out after ${Math.round(batchTimeoutMs / 1000)}s.`,
        exitCode: 124,
      };
      continue;
    }
    outcomes[i] = {
      index: i,
      id: spec.id,
      name: spec.name,
      status: "cancelled",
      ok: false,
      output: "Not run — batch aborted.",
      exitCode: 130,
    };
  }

  const finalOutcomes = outcomes as BatchOutcome[];
  const allOk = finalOutcomes.every((outcome) => outcome.ok);
  const sections = finalOutcomes.map((outcome) => {
    const status = outcome.status;
    const head = `── #${outcome.index + 1} ${outcome.name} [${status}${outcome.exitCode !== undefined ? ` exit=${outcome.exitCode}` : ""}]`;
    const body = outcome.error
      ? `error: ${outcome.error}`
      : outcome.output.trim();
    return `${head}\n${body}`;
  });
  let output = sections.join("\n\n");
  if (hardTimedOut && !allOk) {
    output =
      `[batch] timed out after ${Math.round(batchTimeoutMs / 1000)}s — partial results below\n\n` +
      output;
  } else if (policyCancelCount > 0) {
    const n = finalOutcomes.filter((o) => o.status === "cancelled").length;
    if (n > 0) {
      output =
        `[batch] on_fail cancelled ${n} call(s) — partial results below\n\n` +
        output;
    }
  }
  // `ok` is the signal the runner, loop-guard, and task-evidence layers use, so
  // it reports the truth: a batch whose children failed is NOT a success. The
  // original intent (a failed child must not cancel sibling top-level tools) is
  // preserved by `partial`, which tells the runner this was a partial result
  // rather than an aborted or hard-failed call.
  const anyOk = finalOutcomes.some((outcome) => outcome.ok);
  const allSuppressed =
    finalOutcomes.length > 0 &&
    finalOutcomes.every((outcome) => outcome.suppressedRepeat);
  // Children run in index order in the sectioned body, so keep the same order
  // here: the model is told "attached in this order" and must be able to match
  // each image back to the section that requested it.
  const batchImages = finalOutcomes.flatMap((outcome) => outcome.images ?? []);
  return {
    ok: allOk,
    partial: !allOk && anyOk && !parentAborted && !hardTimedOut,
    output,
    exitCode: allOk ? 0 : hardTimedOut ? 124 : parentAborted ? 130 : 1,
    ...(allSuppressed ? { suppressedRepeat: true } : {}),
    ...(batchImages.length ? { images: batchImages } : {}),
  };
}
