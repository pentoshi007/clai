import type { ConfirmRequest } from "../../ui-core/controllers/overlay-controller.js";
import type { InkTheme } from "../render/ink-theme.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, type PanelEffect, type PanelKeyResult } from "./panel-effect.js";

const TITLES: Record<ConfirmRequest["kind"], string> = {
  tool: "Approve tool",
  pentest: "Authorize pentest",
  reset: "Confirm reset",
  continue: "Step limit",
  plan: "Plan ready",
  switch: "Confirm switch",
};

export interface ConfirmActionKey {
  readonly chord: string;
  readonly label: string;
}

export function confirmActions(request: ConfirmRequest): readonly ConfirmActionKey[] {
  switch (request.kind) {
    case "reset":
      return [{ chord: "r", label: "confirm" }];
    case "plan":
      return [
        { chord: "i", label: "implement" },
        { chord: "d", label: "discard" },
        { chord: "s", label: "suggest changes" },
        { chord: "p", label: "view" },
      ];
    case "continue":
      return [
        { chord: "y", label: "continue" },
        { chord: "n", label: "stop" },
      ];
    default: {
      const keys = [
        { chord: "y", label: "approve" },
        { chord: "n", label: "deny" },
      ];
      return request.viewPath ? [...keys, { chord: "v", label: "preview" }] : keys;
    }
  }
}

export function confirmHints(request: ConfirmRequest): readonly string[] {
  switch (request.kind) {
    case "reset":
      return ["r", "esc cancel"];
    case "plan":
      return ["i/d/s/p", "esc dismiss"];
    default:
      return request.viewPath ? ["y/n/v", "esc deny"] : ["y/n", "esc deny"];
  }
}

export interface ConfirmKeyInput {
  readonly request: ConfirmRequest;
  readonly chord: string;
}

export function confirmKey(input: ConfirmKeyInput): PanelKeyResult<undefined> {
  const { request, chord } = input;
  const emit = (...effects: readonly PanelEffect[]): PanelKeyResult<undefined> =>
    handled(undefined, ...effects);

  if (request.kind === "reset") {
    if (chord === "r") return emit({ kind: "confirm", ok: true });
    if (chord === "escape") return emit({ kind: "confirm", ok: false });
    return emit();
  }

  if (request.kind === "plan") {
    if (chord === "i" || chord === "y" || chord === "enter") {
      return emit({ kind: "confirm-plan", result: "implement" });
    }
    if (chord === "d" || chord === "n") {
      return emit({ kind: "confirm-plan", result: "discard" });
    }
    if (chord === "s") return emit({ kind: "confirm-plan", result: "suggest" });
    if (chord === "p") return emit({ kind: "view-plan" });
    if (chord === "escape") return emit({ kind: "confirm-plan", result: "dismiss" });
    return emit();
  }

  if (chord === "y" || chord === "enter") return emit({ kind: "confirm", ok: true });
  if (chord === "n" || chord === "escape") return emit({ kind: "confirm", ok: false });
  if (chord === "v" && request.viewPath) return emit({ kind: "view-file" });
  return emit();
}

export interface ConfirmViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly request: ConfirmRequest;
}

export function confirmPromptLines(
  prompt: string,
  columns: number,
): readonly string[] {
  return wrapWithPrefixes(prompt.replace(/\r/g, "").trim(), {
    width: panelBodyWidth(columns),
  });
}

export function confirmRowsWanted(
  request: ConfirmRequest,
  columns: number,
): number {
  return confirmPromptLines(request.prompt, columns).length + 4;
}

function confirmBody(input: ConfirmViewInput): readonly string[] {
  const { ink, request } = input;
  const prompt = confirmPromptLines(request.prompt, input.columns);
  const actions = confirmActions(request)
    .map((action) => `${ink.fg("inputBorder", action.chord)} ${action.label}`)
    .join("   ");
  return [
    ...prompt,
    "",
    `${ink.fg("inputBorder", ink.glyphs.promptMark)} ${actions}`,
  ];
}

export function confirmView(input: ConfirmViewInput): PanelFrameInput {
  const { ink, request } = input;
  const body = confirmBody(input);
  const height = panelBodyHeight(input.rows);
  const visible = body.length <= height ? body : [...body.slice(0, Math.max(0, height - 2)), "", body[body.length - 1] ?? ""];
  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: `${ink.glyphs.warning} ${TITLES[request.kind]}`,
    borderColor: "activity",
    hints: confirmHints(request),
    body: visible,
  };
}
