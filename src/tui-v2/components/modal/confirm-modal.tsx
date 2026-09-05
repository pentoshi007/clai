/** @jsxImportSource @opentui/react */

import type { ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import type { ConfirmRequest } from "../../../ui-core/controllers/overlay-controller.js";

export interface ConfirmModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: ConfirmRequest;
  readonly onViewPlan?: (() => void) | undefined;
  readonly onViewFile?: (() => void) | undefined;
  readonly docked?: boolean | undefined;
}

const TITLES: Record<ConfirmRequest["kind"], string> = {
  tool: "CONFIRM ACTION",
  pentest: "AUTHORIZE PENTEST",
  reset: "CONFIRM RESET",
  continue: "STEP LIMIT",
  plan: "PLAN READY",
  switch: "CONFIRM SWITCH",
  "mcp-oauth": "MCP SIGN-IN",
};

export function ConfirmModal(props: ConfirmModalProps): ReactNode {
  const { services, theme, request, onViewPlan, onViewFile, docked } = props;

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    if (request.kind === "reset") {
      if (chord === "r") services.overlay.answerConfirm(true);
      else if (chord === "escape") services.overlay.answerConfirm(false);
      else return;
    } else if (request.kind === "plan") {
      if (chord === "y" || chord === "i" || chord === "enter") {
        services.overlay.answerPlanConfirm("implement");
      } else if (chord === "n" || chord === "d") {
        services.overlay.answerPlanConfirm("discard");
      } else if (chord === "s") {
        services.overlay.answerPlanConfirm("suggest");
      } else if (chord === "p") {
        onViewPlan?.();
      } else if (chord === "escape") {
        services.overlay.answerPlanConfirm("dismiss");
      } else {
        return;
      }
    } else {
      if (chord === "y" || chord === "enter") {
        services.overlay.answerConfirm(true);
      } else if (chord === "n" || chord === "escape") {
        services.overlay.answerConfirm(false);
      } else if (chord === "v" && request.viewPath) {
        onViewFile?.();
      } else return;
    }
    key.preventDefault();
  });

  const accent =
    request.kind === "pentest"
      ? theme.mode
      : request.kind === "plan"
        ? theme.chipTeal
        : request.kind === "reset"
          ? theme.queued
          : theme.cyan;

  const hint =
    request.kind === "reset"
      ? "r confirm  ·  esc cancel"
      : request.kind === "plan"
        ? "y/i implement  ·  s suggest  ·  p view  ·  n/d discard  ·  esc dismiss"
        : request.kind === "continue"
          ? "y continue  ·  n stop  ·  esc cancel"
          : request.viewPath
            ? "y approve  ·  n deny  ·  v view file  ·  esc cancel"
            : "y approve  ·  n deny  ·  esc cancel";

  const promptLines = wrapPrompt(request.prompt, docked ? 88 : 72);

  return (
    <box
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: docked ? "100%" : "70%",
        borderColor: accent,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text
          style={{
            fg: theme.background,
            bg: accent,
            attributes: TextAttributes.BOLD,
          }}
        >
          {` ${TITLES[request.kind]} `}
        </text>
      </box>
      {promptLines.map((line, i) => (
        <text key={i} style={{ fg: theme.foreground }}>
          {line}
        </text>
      ))}
      <box style={{ flexDirection: "row", width: "100%", marginTop: 0 }}>
        <text style={{ fg: theme.cyan, attributes: TextAttributes.BOLD }}>› </text>
        <text style={{ fg: theme.cyan }}>{hint}</text>
      </box>
    </box>
  );
}

function wrapPrompt(text: string, width: number): string[] {
  const raw = text.replace(/\r/g, "").trim();
  if (!raw) return [""];
  const out: string[] = [];
  for (const paragraph of raw.split("\n")) {
    if (!paragraph.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (!line) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out.length > 0 ? out : [raw];
}
