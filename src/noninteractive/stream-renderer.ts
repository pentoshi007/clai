/**
 * Append-only transcript renderer for the non-interactive surface
 * (06-ONESHOT §2/§3).
 *
 * stdout carries the assistant answer and nothing else; every status, notice,
 * thinking row, tool card, diff, compaction row and spinner frame goes to
 * stderr. No cursor movement or erase sequence is ever written to stdout, so a
 * redirected run stays a correct transcript.
 */

import type { AgentEvent } from "../agent/events.js";
import type { TurnOutcome } from "../agent/turn-outcome.js";
import { renderTurnOutcome } from "../agent/turn-outcome.js";
import { formatElapsed } from "../classic/blocks/block-context.js";
import { isBatchToolName } from "../ui-core/rendering/batch-sections.js";
import {
  buildAssistantMessageLines,
  buildBatchLines,
  buildCompactedLines,
  buildCompactionCompletedLines,
  buildCompactionFailedLines,
  buildCompactionStartLines,
  buildConfirmRequestLines,
  buildContextEstimateLines,
  buildNoticeLines,
  buildPlanUpdateLines,
  buildStatusLines,
  buildThinkingBlockLines,
  buildTokenUsageLines,
  buildToolBlockedLines,
  buildToolCallLines,
  buildToolDiffLines,
  buildToolOutputLines,
  buildToolResultLines,
  buildTurnAbortedLines,
  buildTurnErrorLines,
  buildTurnStartLines,
  createStreamContext,
  renderAnswerLines,
  type StreamContext,
  type StreamVerbosity,
} from "./stream-blocks.js";
import { StreamSpinner } from "./stream-spinner.js";

export interface StreamRendererOptions {
  readonly out: NodeJS.WritableStream;
  readonly err: NodeJS.WritableStream;
  readonly columns: number;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly verbosity: StreamVerbosity;
  readonly showThinking: boolean;
}

interface ToolRecord {
  readonly name: string;
  body: string;
  startedAt: number;
}

export class StreamRenderer {
  private readonly ctx: StreamContext;
  private readonly spinner: StreamSpinner;
  private readonly tools = new Map<string, ToolRecord>();
  private readonly startedAt: number;
  private label = "working";
  private lastAnswer = "";
  private finished = false;

  constructor(
    private readonly options: StreamRendererOptions,
    private readonly clock: () => number = Date.now,
  ) {
    this.ctx = createStreamContext(options);
    this.startedAt = clock();
    this.spinner = new StreamSpinner({
      err: options.err as NodeJS.WritableStream & { isTTY?: boolean | undefined },
      columns: options.columns,
      unicode: options.unicode,
      enabled: options.verbosity !== "quiet",
    });
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "turn-start":
        this.writeErr(buildTurnStartLines(this.ctx, event));
        this.spin("waiting for model");
        return;
      case "status":
        this.writeErr(buildStatusLines(this.ctx, event));
        this.spin(event.text.trim() || this.label);
        return;
      case "thinking-delta":
      case "assistant-delta":
      case "compaction-delta":
      case "tool-start":
      case "turn-end":
        return;
      case "thinking-block":
        this.writeErr(buildThinkingBlockLines(this.ctx, event));
        return;
      case "assistant-message":
        this.writeOut(buildAssistantMessageLines(this.ctx, event));
        return;
      case "notice":
        this.writeErr(buildNoticeLines(this.ctx, event));
        return;
      case "tool-call":
        this.tools.set(event.id, { name: event.name, body: "", startedAt: this.clock() });
        this.writeErr(buildToolCallLines(this.ctx, event));
        this.spin(`tool: ${event.name}`);
        return;
      case "tool-output": {
        const record = this.tools.get(event.id);
        if (!record) return;
        record.body = event.replace ? event.chunk : `${record.body}${event.chunk}`;
        return;
      }
      case "tool-result":
        this.writeErr(this.toolResultLines(event));
        this.tools.delete(event.id);
        this.spin("waiting for model");
        return;
      case "tool-blocked":
        this.tools.delete(event.id);
        this.writeErr(buildToolBlockedLines(this.ctx, event));
        return;
      case "plan-update":
        this.writeErr(buildPlanUpdateLines(this.ctx, event));
        return;
      case "confirm-request":
        this.writeErr(buildConfirmRequestLines(this.ctx, event));
        return;
      case "turn-aborted":
        this.writeErr(buildTurnAbortedLines(this.ctx));
        return;
      case "turn-error":
        this.writeErr(buildTurnErrorLines(this.ctx, event));
        return;
      case "compaction-start":
        this.writeErr(buildCompactionStartLines(this.ctx, event));
        this.spin("compacting context");
        return;
      case "compaction-completed":
        this.writeErr(buildCompactionCompletedLines(this.ctx, event));
        return;
      case "compaction-failed":
        this.writeErr(buildCompactionFailedLines(this.ctx, event));
        return;
      case "compacted":
        this.writeErr(buildCompactedLines(this.ctx, event));
        return;
      case "token-usage":
        this.writeErr(buildTokenUsageLines(this.ctx, event));
        return;
      case "context-estimate":
        this.writeErr(buildContextEstimateLines(this.ctx, event));
        return;
    }
  }

  /** Writes the rendered outcome to stdout exactly once and stops the spinner. */
  finish(outcome: TurnOutcome): void {
    if (this.finished) return;
    this.finished = true;
    this.spinner.clear();
    const lines = renderAnswerLines(this.ctx, renderTurnOutcome(outcome));
    const text = lines.join("\n");
    if (text === "" || text === this.lastAnswer) return;
    this.options.out.write(`${text}\n`);
  }

  private toolResultLines(
    event: Extract<AgentEvent, { type: "tool-result" }>,
  ): readonly string[] {
    const record = this.tools.get(event.id);
    const name = record?.name ?? "tool";
    const elapsed =
      record === undefined ? undefined : formatElapsed(this.clock() - record.startedAt);
    if (event.fileChanges && event.fileChanges.length > 0) {
      return buildToolDiffLines(this.ctx, event, name);
    }
    const body = record?.body ?? "";
    const preview = isBatchToolName(name)
      ? buildBatchLines(this.ctx, body)
      : buildToolOutputLines(
          this.ctx,
          { type: "tool-output", id: event.id, chunk: body, replace: true },
          { name },
        );
    return [
      ...preview,
      ...buildToolResultLines(this.ctx, event, { elapsed: elapsed || undefined }),
    ];
  }

  private spin(label: string): void {
    this.label = label;
    const elapsed = formatElapsed(this.clock() - this.startedAt);
    this.spinner.tick(elapsed === "" ? label : `${label} · ${elapsed}`);
  }

  private writeOut(lines: readonly string[]): void {
    if (lines.length === 0) return;
    this.spinner.clear();
    const text = lines.join("\n");
    this.lastAnswer = text;
    this.options.out.write(`${text}\n`);
  }

  private writeErr(lines: readonly string[]): void {
    if (lines.length === 0 || this.options.verbosity === "quiet") return;
    this.spinner.clear();
    this.options.err.write(`${lines.join("\n")}\n`);
  }
}
