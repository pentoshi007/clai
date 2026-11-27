import type { QuestionRequest, UserQuestion } from "../../app/ports/question-port.js";
import {
  currentQuestion,
  customRowIndex,
  questionFlowKey,
  type QuestionFlowState,
} from "../../ui-core/question/question-flow.js";
import { questionOptionLines, type QuestionOptionLine } from "../../ui-core/question/option-layout.js";
import { sealStyle } from "../render/ansi-text.js";
import { ASCII_GLYPHS, type Glyphs } from "../render/glyphs.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";
import { layoutWidth } from "../render/measure.js";
import { wrapWithPrefixes } from "../render/wrap.js";
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

interface OptionBlock {
  readonly lines: readonly QuestionOptionLine[];
  readonly active: boolean;
  readonly labelToken: ThemeToken;
}

const MARKER_WIDTH = 2;

function optionBlocks(glyphs: Glyphs, request: QuestionRequest, state: QuestionPanelState, columns: number): OptionBlock[] {
  const question = currentQuestion(request, state);
  const width = Math.max(1, panelBodyWidth(columns) - MARKER_WIDTH);
  const chosen = state.selected[state.index] ?? [];
  const options = question.options.map((option, index) => {
    const box = question.multiSelect ? (chosen.includes(index) ? "[x] " : "[ ] ") : "";
    const tick = !question.multiSelect && chosen.includes(index) ? ` ${glyphs.taskDone}` : "";
    return {
      lines: questionOptionLines({ prefix: `${index + 1}. ${box}`, label: `${option.label}${tick}`, description: option.description, width }),
      active: !state.editing && state.cursor === index,
      labelToken: "foreground" as const,
    };
  });
  const customIndex = customRowIndex(question);
  const saved = state.custom[state.index] ?? "";
  const prefix = `${customIndex + 1}. `;
  const customLabel = state.editing
    ? `${visibleTail(state.draft, Math.max(1, width - layoutWidth(prefix) - 1))}${glyphs.caret}`
    : saved || `Type your own answer${glyphs.ellipsis}`;
  return [
    ...options,
    {
      lines: questionOptionLines({ prefix, label: customLabel, width }),
      active: state.cursor === customIndex,
      labelToken: state.editing || saved ? "foreground" : "muted",
    },
  ];
}

function blockRows(ink: InkTheme, block: OptionBlock, width: number): string[] {
  return block.lines.map((line, index) => {
    const marker = block.active && index === 0 ? `${ink.glyphs.promptMark} ` : "  ";
    if (block.active) return ink.selectedRow(`${marker}${line.label}${line.description}`, width);
    return sealStyle(
      `${ink.style(marker, { fg: "inputBorder" })}${ink.style(line.label, { fg: block.labelToken })}${ink.fg("muted", line.description)}`,
    );
  });
}

function promptLines(question: UserQuestion, width: number): string[] {
  return wrapWithPrefixes(question.question, { width });
}

function questionBody(input: QuestionViewInput): string[] {
  const { ink, state } = input;
  const question = currentQuestion(input.request, state);
  const width = panelBodyWidth(input.columns);
  const prompt = promptLines(question, width).map((line) => ink.style(line, { bold: true }));
  const options = optionBlocks(ink.glyphs, input.request, state, input.columns).flatMap((block) => blockRows(ink, block, width));
  return [...prompt, "", ...options];
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
  const options = optionBlocks(ASCII_GLYPHS, input.request, input.state, input.columns).reduce((total, block) => total + block.lines.length, 0);
  return prompt + 1 + options + 2;
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
