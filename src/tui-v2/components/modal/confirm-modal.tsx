/** @jsxImportSource @opentui/react */

import type { ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import type { ConfirmRequest } from "../../../ui-core/controllers/overlay-controller.js";
import { confirmationPreview } from "../../../ui-core/rendering/confirmation-preview.js";
import { fitOneLine } from "../../../ui-core/rendering/pager-chrome.js";

export interface ConfirmModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: ConfirmRequest;
  readonly width: number;
  readonly height: number;
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
  install: "INSTALL ENGINE",
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
      } else if (chord === "ctrl+o" && request.review) {
        services.overlay.openOperationReview();
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

  const reviewHint = request.review ? "  ·  ctrl+o view operation" : "";
  const hint =
    request.kind === "reset"
      ? "r confirm  ·  esc cancel"
      : request.kind === "plan"
        ? "y/i implement  ·  s suggest  ·  p view  ·  n/d discard  ·  esc dismiss"
        : request.kind === "continue"
          ? "y continue  ·  n stop  ·  esc cancel"
          : request.viewPath
            ? `y approve  ·  n deny  ·  v view file${reviewHint}  ·  esc cancel`
            : `y approve  ·  n deny${reviewHint}  ·  esc cancel`;

  const modalWidth = docked ? props.width : Math.floor(props.width * 0.7);
  const contentWidth = Math.max(1, modalWidth - 4);
  const preview = confirmationPreview(request, contentWidth, props.height - 4);
  const compactHint = request.kind === "reset"
    ? "r confirm · esc cancel"
    : request.kind === "plan"
      ? "i/d/s/p · esc dismiss"
      : `y/n${request.viewPath ? " · v file" : ""}${request.review ? " · ^O full" : ""} · esc deny`;
  const keys = request.kind === "reset" ? "r" : request.kind === "plan" ? "i/d/s/p"
    : `y/n${request.viewPath ? "/v" : ""}${request.review ? "/^O" : ""}`;
  const actionHint = fitOneLine([hint, compactHint, `${keys} · esc`], Math.max(1, contentWidth - 2));

  return (
    <box
      id="confirm-modal"
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: modalWidth,
        maxHeight: props.height,
        flexShrink: 0,
        overflow: "hidden",
        borderColor: accent,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      <box style={{ flexDirection: "row", width: "100%", height: 1, flexShrink: 0, overflow: "hidden" }}>
        <text
          wrapMode="none"
          style={{
            fg: theme.background,
            bg: accent,
            attributes: TextAttributes.BOLD,
            height: 1,
          }}
        >
          {` ${TITLES[request.kind]} `}
        </text>
      </box>
      <box id="confirm-reason" style={{ flexDirection: "column", width: "100%", height: preview.reasonLines.length, flexShrink: 0 }}>
        {preview.reasonLines.map((line, i) => (
          <text key={i} content={line} wrapMode="none" style={{ fg: theme.activity, height: 1, flexShrink: 0 }} />
        ))}
      </box>
      <box id="confirm-preview" style={{ flexDirection: "column", width: "100%", height: preview.promptLines.length, flexShrink: 0 }}>
        {preview.promptLines.map((line, i) => (
          <text key={i} content={line} wrapMode="none" style={{ fg: theme.foreground, height: 1, flexShrink: 0 }} />
        ))}
      </box>
      <box id="confirm-actions" style={{ flexDirection: "row", width: "100%", height: 1, flexShrink: 0, marginTop: 0 }}>
        <text content="› " wrapMode="none" style={{ fg: theme.cyan, height: 1, flexShrink: 0, attributes: TextAttributes.BOLD }} />
        <text content={actionHint} wrapMode="none" style={{ fg: theme.cyan, height: 1 }} />
      </box>
    </box>
  );
}
