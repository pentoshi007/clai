import type { ToolCall, ToolResult } from "../../types.js";
import { isScaffoldCreateCommand } from "../task-evidence.js";
import {
  isScaffoldCancelledOutput,
  scaffoldLooksMaterialized,
} from "../workspace-orient.js";
import { extractProjectRootFromScaffold } from "../project-root.js";

export interface ScaffoldOutcome {
  readonly result: ToolResult;
  readonly adoptRoot: string | undefined;
  readonly notice: string | undefined;
}

interface ScaffoldContext {
  readonly out: string;
  readonly root: string | undefined;
  readonly cancelled: boolean;
  readonly materialized: boolean;
  readonly abortedMid: boolean;
}

const RESUME_GUIDANCE =
  "Inspect the existing files, finish any missing install, implement the requested feature, then run/verify.";

const RETRY_GUIDANCE =
  "If the folder already exists, CONTINUE it (do not re-scaffold). Otherwise use a new empty name or hand-write a minimal tree.";

const withTrailingNewline = (text: string): string =>
  text.endsWith("\n") ? text : `${text}\n`;

const failureExitCode = (result: ToolResult): number =>
  result.exitCode && result.exitCode !== 0 ? result.exitCode : 1;

const readContext = (call: ToolCall, result: ToolResult): ScaffoldContext => {
  const command = String(call.args.command ?? "");
  const cwdArg = typeof call.args.cwd === "string" ? call.args.cwd : undefined;
  const out = result.output ?? "";
  const fromOutput = out
    .match(/Scaffolding project in\s+([^\n]+?)\s*\.{0,3}\s*$/im)?.[1]
    ?.trim()
    .replace(/['"]/g, "");
  const root =
    (fromOutput && fromOutput.startsWith("/") ? fromOutput : undefined) ??
    extractProjectRootFromScaffold(command, cwdArg);
  return {
    out,
    root,
    cancelled: isScaffoldCancelledOutput(out),
    materialized: scaffoldLooksMaterialized(root),
    abortedMid:
      !result.ok &&
      (result.exitCode === 124 ||
        result.exitCode === 130 ||
        /timed out|aborted|Command aborted/i.test(out)),
  };
};

const resumableOutcome = (
  result: ToolResult,
  context: ScaffoldContext,
  root: string,
): ScaffoldOutcome => ({
  result: {
    ...result,
    ok: true,
    exitCode: 0,
    output:
      withTrailingNewline(context.out) +
      `The scaffold reported ${context.cancelled ? "cancellation/refusal" : "interruption"}, but a usable project tree already exists at ${root} ` +
      `(package/manifest present). Treat this as resumable: do NOT re-run the scaffolder. ` +
      RESUME_GUIDANCE,
  },
  adoptRoot: root,
  notice: `project root → ${root} (existing materialized scaffold — continue)`,
});

const failedOutcome = (
  result: ToolResult,
  context: ScaffoldContext,
  headline: string,
): ScaffoldOutcome => ({
  result: {
    ok: false,
    output:
      withTrailingNewline(context.out) +
      headline +
      (context.root ? `Expected project at ${context.root}. ` : "") +
      RETRY_GUIDANCE,
    exitCode: failureExitCode(result),
  },
  adoptRoot: undefined,
  notice: undefined,
});

const unchanged = (result: ToolResult): ScaffoldOutcome => ({
  result,
  adoptRoot: undefined,
  notice: undefined,
});

const adopted = (
  result: ToolResult,
  root: string,
  notice: string,
): ScaffoldOutcome => ({ result, adoptRoot: root, notice });

const decide = (
  result: ToolResult,
  context: ScaffoldContext,
): ScaffoldOutcome => {
  const resumable = Boolean(
    context.root &&
      context.materialized &&
      (context.cancelled || context.abortedMid || !result.ok),
  );
  if (resumable && context.root) {
    return resumableOutcome(result, context, context.root);
  }
  if (result.ok && context.cancelled && !context.materialized) {
    return failedOutcome(
      result,
      context,
      "Scaffold FAILED: tool reported cancel/refuse. ",
    );
  }
  if (result.ok && !context.materialized) {
    if (!/Scaffolding project in\b/i.test(context.out)) {
      return failedOutcome(
        result,
        context,
        "Scaffold FAILED: target project tree was not created. ",
      );
    }
    return context.root
      ? adopted(
          result,
          context.root,
          `project root → ${context.root} (scaffold output claimed success — continue)`,
        )
      : unchanged(result);
  }
  if (result.ok && context.root && context.materialized) {
    return adopted(result, context.root, `project root → ${context.root}`);
  }
  return unchanged(result);
};

export const reconcileScaffoldOutcome = (
  call: ToolCall,
  result: ToolResult,
): ScaffoldOutcome => {
  if (call.name !== "shell.exec" && call.name !== "shell.start") {
    return unchanged(result);
  }
  if (
    typeof call.args.command !== "string" ||
    !isScaffoldCreateCommand(call.args.command)
  ) {
    return unchanged(result);
  }
  return decide(result, readContext(call, result));
};
