import type { ConfirmRequest } from "../../ui-core/controllers/overlay-controller.js";
import type { InkTheme } from "../render/ink-theme.js";
import { confirmationPreview, wrapConfirmationText } from "../../ui-core/rendering/confirmation-preview.js";
import { fitOneLine } from "../../ui-core/rendering/pager-chrome.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, type PanelEffect, type PanelKeyResult } from "./panel-effect.js";

const TITLES: Record<ConfirmRequest["kind"], string> = {
  tool: "Approve tool",
  pentest: "Authorize pentest",
  reset: "Confirm reset",
  continue: "Step limit",
  plan: "Plan ready",
  switch: "Confirm switch",
  "mcp-oauth": "MCP sign-in",
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
      const preview = request.viewPath ? [{ chord: "v", label: "preview" }] : [];
      const review = request.review ? [{ chord: "ctrl+o", label: "view operation" }] : [];
      return [...keys, ...preview, ...review];
    }
  }
}

export function confirmHints(request: ConfirmRequest): readonly string[] {
  switch (request.kind) {
    case "reset":
      return ["r", "esc cancel"];
    case "plan":
      return ["i/d/s/p", "esc dismiss"];
    default: {
      const keys = ["y/n", ...(request.viewPath ? ["v"] : []), ...(request.review ? ["ctrl+o"] : [])];
      return [keys.join("/"), "esc deny"];
    }
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
  if (chord === "ctrl+o" && request.review) return emit({ kind: "view-operation" });
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
  return wrapConfirmationText(prompt, panelBodyWidth(columns));
}

export function confirmRowsWanted(
  request: ConfirmRequest,
  columns: number,
): number {
  const preview = confirmationPreview(request, panelBodyWidth(columns));
  return preview.reasonLines.length + preview.promptLines.length + 4;
}

function confirmBody(input: ConfirmViewInput): readonly string[] {
  const { ink, request } = input;
  const width = panelBodyWidth(input.columns);
  const height = panelBodyHeight(input.rows);
  const spacer = height >= 5 ? [""] : [];
  const preview = confirmationPreview(request, width, height - spacer.length - 1);
  const actions = confirmActions(request)
    .map((action) => `${ink.fg("inputBorder", action.chord)} ${action.label}`)
    .join("   ");
  return [
    ...preview.reasonLines.map((line) => ink.fg("activity", line)),
    ...preview.promptLines,
    ...spacer,
    fitOneLine([
      `${ink.fg("inputBorder", ink.glyphs.promptMark)} ${actions}`,
      `${ink.glyphs.promptMark} ${confirmHints(request).join(" · ")}`,
    ], width),
  ];
}

export function confirmView(input: ConfirmViewInput): PanelFrameInput {
  const { ink, request } = input;
  const body = confirmBody(input);
  const height = panelBodyHeight(input.rows);
  const visible = height === 0 ? [] : body.slice(-height);
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
