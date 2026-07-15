/** @jsxImportSource @opentui/react */
/**
 * Typed confirmation surface (CORE-002, PICK-002, V2-073).
 *
 * Ported from the classic TUI's `ConfirmModal`: y/n answer most kinds; reset
 * requires the deliberate "r" key instead of "y" so it can't be fat-fingered;
 * the plan-ready kind adds "p" to view the full plan without answering yet
 * (the confirm promise is intentionally left pending — /implement and
 * /discard remain available afterward, matching the classic TUI).
 */

import type { ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import type { AppServices } from "../../bootstrap/composition-root.js";
import type { Theme } from "../../rendering/theme.js";
import { chordFromKeyEvent } from "../../actions/chord-from-key.js";
import type { ConfirmRequest } from "../../controllers/overlay-controller.js";

export interface ConfirmModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: ConfirmRequest;
  readonly onViewPlan?: (() => void) | undefined;
}

const TITLES: Record<ConfirmRequest["kind"], string> = {
  tool: "ACTION REQUIRED · CONFIRMATION",
  pentest: "ACTION REQUIRED · AUTHORIZATION",
  reset: "ACTION REQUIRED · RESET CONFIRMATION",
  continue: "STEP LIMIT REACHED",
  plan: "PLAN READY · IMPLEMENT OR DISCARD",
  switch: "ACTION REQUIRED · CONFIRMATION",
};

export function ConfirmModal(props: ConfirmModalProps): ReactNode {
  const { services, theme, request, onViewPlan } = props;

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    const chord = chordFromKeyEvent(key);
    if (request.kind === "reset") {
      if (chord === "r") services.overlay.answerConfirm(true);
      else if (chord === "escape") services.overlay.answerConfirm(false);
      else return;
    } else if (request.kind === "plan") {
      if (chord === "y" || chord === "i") services.overlay.answerConfirm(true);
      else if (chord === "n" || chord === "d" || chord === "escape") services.overlay.answerConfirm(false);
      else if (chord === "p") onViewPlan?.();
      else return;
    } else {
      if (chord === "y") services.overlay.answerConfirm(true);
      else if (chord === "n" || chord === "escape") services.overlay.answerConfirm(false);
      else return;
    }
    key.preventDefault();
  });

  const color =
    request.kind === "pentest"
      ? theme.mode
      : request.kind === "plan"
        ? theme.chipTeal
        : request.kind === "reset"
          ? theme.queued
          : theme.modalBorder;
  const hint =
    request.kind === "reset"
      ? "r:reset  ·  esc:cancel"
      : request.kind === "plan"
        ? "y:implement  ·  n:discard  ·  p:view-plan  ·  esc:cancel"
        : request.kind === "continue"
          ? "y:continue  ·  n:stop  ·  esc:cancel"
          : "y:approve  ·  n:deny  ·  esc:cancel";

  return (
    <box
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: "70%",
        borderColor: color,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 1,
        paddingBottom: 1,
      }}
    >
      <text style={{ fg: theme.white, bg: color }}> {TITLES[request.kind]} </text>
      <text content=" " />
      <text style={{ fg: theme.foreground }}>{request.prompt}</text>
      <text content=" " />
      <text style={{ fg: theme.border }}>{"─".repeat(40)}</text>
      <text content=" " />
      <text style={{ fg: theme.cyan }}>{hint}</text>
    </box>
  );
}
