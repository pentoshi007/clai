/** @jsxImportSource @opentui/react */

import { useRef, useState, type ReactNode } from "react";
import { useKeyboard, usePaste } from "@opentui/react";
import { TextAttributes, decodePasteBytes } from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import type { QuestionRequest } from "../../../app/ports/question-port.js";
import {
  currentQuestion,
  customRowIndex,
  questionFlowInitialState,
  questionFlowKey,
  questionFlowPaste,
  type QuestionFlowOutcome,
  type QuestionFlowState,
} from "../../../ui-core/question/question-flow.js";
import { wrapConfirmationText } from "../../../ui-core/rendering/confirmation-preview.js";
import { fitOneLine } from "../../../ui-core/rendering/pager-chrome.js";
import { sanitizeDisplayText } from "../../../ui-core/rendering/sanitize-display.js";
import { chordFromKeyEvent, isKeyEventRelease } from "../../input/chord-from-opentui-key.js";

export interface QuestionModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: QuestionRequest;
  readonly width: number;
  readonly docked?: boolean | undefined;
}

function hintLine(request: QuestionRequest, state: QuestionFlowState, width: number): string {
  if (state.editing) return fitOneLine(["enter save  ·  ctrl+u clear  ·  esc back", "enter · esc"], width);
  const question = currentQuestion(request, state);
  const last = state.index + 1 >= request.questions.length;
  const parts = [
    "↑↓ move",
    `1-${question.options.length + 1} pick`,
    ...(question.multiSelect ? ["space toggle"] : []),
    `enter ${last ? "submit" : "next"}`,
    ...(state.index > 0 ? ["← back"] : []),
    "esc skip",
  ];
  return fitOneLine([parts.join("  ·  "), parts.join(" · "), "enter · esc"], width);
}

export function QuestionModal(props: QuestionModalProps): ReactNode {
  const { services, theme, request } = props;
  const [state, setState] = useState(() => questionFlowInitialState(request));
  const stateRef = useRef(state);

  function update(next: QuestionFlowState): void {
    stateRef.current = next;
    setState(next);
  }

  function apply(outcome: QuestionFlowOutcome): void {
    if (outcome.kind === "continue") update(outcome.state);
    else services.overlay.answerQuestions(outcome.kind === "submit" ? outcome.answers : undefined);
  }

  useKeyboard((key) => {
    if (isKeyEventRelease(key) || key.defaultPrevented) return;
    const outcome = questionFlowKey(request, stateRef.current, chordFromKeyEvent(key), key.sequence);
    if (!outcome) return;
    key.preventDefault();
    apply(outcome);
  });

  usePaste((event) => {
    try {
      const text = sanitizeDisplayText(decodePasteBytes(event.bytes));
      const next = questionFlowPaste(request, stateRef.current, text);
      if (next === stateRef.current) return;
      event.preventDefault();
      update(next);
    } catch {
    }
  });

  const question = currentQuestion(request, state);
  const modalWidth = props.docked ? props.width : Math.floor(props.width * 0.7);
  const contentWidth = Math.max(1, modalWidth - 4);
  const promptLines = wrapConfirmationText(question.question, contentWidth);
  const counter = request.questions.length > 1 ? ` ${state.index + 1}/${request.questions.length}` : "";
  const selected = state.selected[state.index] ?? [];
  const customIndex = customRowIndex(question);
  const savedCustom = state.custom[state.index] ?? "";
  const rows = [
    ...question.options.map((option, index) => {
      const box = question.multiSelect ? (selected.includes(index) ? "[x] " : "[ ] ") : "";
      const tick = !question.multiSelect && selected.includes(index) ? " ✓" : "";
      const description = option.description ? ` — ${option.description}` : "";
      return { index, label: `${index + 1}. ${box}${option.label}${tick}`, description };
    }),
    {
      index: customIndex,
      label: `${customIndex + 1}. ${state.editing ? `${state.draft}▏` : savedCustom || "Type your own answer…"}`,
      description: "",
    },
  ];

  return (
    <box
      id="question-modal"
      border
      borderStyle="rounded"
      style={{
        flexDirection: "column",
        width: modalWidth,
        flexShrink: 0,
        overflow: "hidden",
        borderColor: theme.accent,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      <box style={{ flexDirection: "row", width: "100%", height: 1, flexShrink: 0, overflow: "hidden" }}>
        <text wrapMode="none" style={{ fg: theme.background, bg: theme.accent, attributes: TextAttributes.BOLD, height: 1 }}>
          {` ${(question.header ?? "Question").toUpperCase()}${counter} `}
        </text>
      </box>
      {promptLines.map((line, index) => (
        <text
          key={`prompt-${index}`}
          content={line}
          wrapMode="none"
          style={{ fg: theme.foreground, attributes: TextAttributes.BOLD, height: 1, flexShrink: 0 }}
        />
      ))}
      {rows.map((row) => {
        const active = state.cursor === row.index && (!state.editing || row.index === customIndex);
        const muted = row.index === customIndex && !state.editing && !savedCustom;
        return (
          <box
            key={`row-${row.index}`}
            style={{ flexDirection: "row", width: "100%", height: 1, flexShrink: 0, overflow: "hidden" }}
            onMouseDown={() => {
              const moved = { ...stateRef.current, cursor: row.index };
              apply(questionFlowKey(request, moved, "enter") ?? { kind: "continue", state: moved });
            }}
          >
            <text content={active ? "› " : "  "} wrapMode="none" style={{ fg: theme.accent, height: 1, flexShrink: 0, attributes: TextAttributes.BOLD }} />
            <text
              content={row.label}
              wrapMode="none"
              style={{
                fg: active ? theme.accent : muted ? theme.muted : theme.foreground,
                attributes: active ? TextAttributes.BOLD : TextAttributes.NONE,
                height: 1,
                flexShrink: 0,
              }}
            />
            <text content={row.description} wrapMode="none" style={{ fg: theme.muted, height: 1 }} />
          </box>
        );
      })}
      <text content={hintLine(request, state, contentWidth)} wrapMode="none" style={{ fg: theme.muted, attributes: TextAttributes.DIM, height: 1, flexShrink: 0 }} />
    </box>
  );
}
