import type { QuestionRequest, UserQuestion } from "../../app/ports/question-port.js";
import {
  currentQuestion,
  customRowIndex,
  questionFlowKey,
  type QuestionFlowState,
} from "../../ui-core/question/question-flow.js";
import type { InkTheme } from "../render/ink-theme.js";
import { layoutWidth } from "../render/measure.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { listRow, showsDescription } from "./list-rows.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";

export type QuestionPanelState = QuestionFlowState;

export interface QuestionKeyInput {
  readonly request: QuestionRequest;
  readonly state: QuestionPanelState;
  readonly chord: string;
  readonly text?: string | undefined;
}

export function questionKey(input: QuestionKeyInput): PanelKeyResult<QuestionPanelState> {
  const outcome = questionFlowKey(input.request, input.state, input.chord, input.text);
  if (!outcome) return unhandled(input.state);
  if (outcome.kind === "continue") return handled(outcome.state);
  return handled(input.state, {
    kind: "questions",
    answers: outcome.kind === "submit" ? outcome.answers : undefined,
  });
}

export interface QuestionViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly request: QuestionRequest;
  readonly state: QuestionPanelState;
}

function visibleTail(text: string, width: number): string {
  const chars = [...text];
  while (chars.length > 0 && layoutWidth(chars.join("")) > width) chars.shift();
  return chars.join("");
}

function optionLabel(ink: InkTheme, question: UserQuestion, state: QuestionPanelState, option: number): string {
  const chosen = state.selected[state.index]?.includes(option) ?? false;
  const box = question.multiSelect ? (chosen ? "[x] " : "[ ] ") : "";
  const tick = !question.multiSelect && chosen ? ` ${ink.glyphs.taskDone}` : "";
  return `${option + 1}. ${box}${question.options[option]!.label}${tick}`;
}

function customLabel(ink: InkTheme, question: UserQuestion, state: QuestionPanelState, width: number): string {
  const prefix = `${customRowIndex(question) + 1}. `;
  if (state.editing) {
    const room = Math.max(1, width - layoutWidth(prefix) - 4);
    return `${prefix}${visibleTail(state.draft, room)}${ink.glyphs.caret}`;
  }
  const saved = state.custom[state.index] ?? "";
  return `${prefix}${saved || `Type your own answer${ink.glyphs.ellipsis}`}`;
}

function promptLines(question: UserQuestion, width: number): string[] {
  return wrapWithPrefixes(question.question, { width });
}

function detailLines(question: UserQuestion, state: QuestionPanelState, columns: number): string[] {
  const description = question.options[state.cursor]?.description;
  if (!description || showsDescription(columns)) return [];
  return wrapWithPrefixes(description, { width: panelBodyWidth(columns), firstPrefix: "   " });
}

function questionBody(input: QuestionViewInput): string[] {
  const { ink, state } = input;
  const question = currentQuestion(input.request, state);
  const width = panelBodyWidth(input.columns);
  const prompt = promptLines(question, width).map((line) => ink.style(line, { bold: true }));
  const options = question.options.map((option, index) =>
    listRow({
      ink,
      width,
      columns: input.columns,
      label: optionLabel(ink, question, state, index),
      description: option.description,
      active: !state.editing && state.cursor === index,
    }),
  );
  const customActive = state.cursor === customRowIndex(question);
  const custom = listRow({
    ink,
    width,
    columns: input.columns,
    label: customLabel(ink, question, state, width),
    active: customActive,
    labelToken: state.editing || state.custom[state.index] ? "foreground" : "muted",
  });
  const detail = detailLines(question, state, input.columns).map((line) => ink.fg("muted", line));
  return [...prompt, "", ...options, custom, ...detail];
}

function questionHints(input: QuestionViewInput): string[] {
  const { ink, request, state } = input;
  if (state.editing) return [`${ink.glyphs.enter} save`, "^U clear", "esc back"];
  const question = currentQuestion(request, state);
  const last = state.index + 1 >= request.questions.length;
  return [
    `${ink.glyphs.scrollUp}${ink.glyphs.scrollDown}`,
    `1-${question.options.length + 1} pick`,
    ...(question.multiSelect ? ["space toggle"] : []),
    `${ink.glyphs.enter} ${last ? "submit" : "next"}`,
    ...(state.index > 0 ? ["← back"] : []),
    "esc skip",
  ];
}

export interface QuestionRowsInput {
  readonly columns: number;
  readonly request: QuestionRequest;
  readonly state: QuestionPanelState;
}

export function questionRowsWanted(input: QuestionRowsInput): number {
  const question = currentQuestion(input.request, input.state);
  const prompt = promptLines(question, panelBodyWidth(input.columns)).length;
  const detail = detailLines(question, input.state, input.columns).length;
  return prompt + 1 + question.options.length + 1 + detail + 2;
}

export function questionView(input: QuestionViewInput): PanelFrameInput {
  const { ink, request, state } = input;
  const question = currentQuestion(request, state);
  const height = panelBodyHeight(input.rows);
  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: `? ${question.header ?? "Question"}`,
    counter: request.questions.length > 1 ? `${state.index + 1}/${request.questions.length}` : undefined,
    borderColor: "accent",
    hints: questionHints(input),
    body: questionBody(input).slice(0, Math.max(0, height)),
  };
}
