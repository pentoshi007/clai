import type { Mode } from "../../types.js";
import {
  countComposerVisualLines,
  resolveComposerTextRows,
} from "../../ui-core/composer/composer-height.js";
import { clipComposerMeta } from "../../ui-core/composer/composer-meta.js";
import type { ThemeToken } from "../render/ink-theme.js";
import { COMPOSER_BORDER_ROWS, COMPOSER_DIR_ROWS, COMPOSER_GAP_ROWS } from "./row-budget.js";

export type ComposerPhase = "idle" | "running" | "suspended";

export interface ComposerFrameInput {
  readonly columns: number;
  readonly allocatedRows: number;
  readonly text: string;
  readonly mode: Mode;
  readonly phase: ComposerPhase;
  readonly unicode: boolean;
  readonly metaLabel?: string | undefined;
}

export interface ComposerFrame {
  readonly width: number;
  readonly textWidth: number;
  readonly textRows: number;
  readonly borderStyle: "round" | "classic";
  readonly borderColor: ThemeToken;
  readonly markColor: ThemeToken;
  readonly mark: string;
  readonly placeholder: string;
  readonly showCaret: boolean;
  readonly meta: string;
  readonly showDirectory: boolean;
}

export const COMPOSER_CHROME_COLS = 5;

const PLACEHOLDER: Record<Mode, string> = {
  ask: "Ask anything...",
  agent: "Describe the task...",
  plan: "What should I plan?",
};

export function composerPlaceholder(mode: Mode, phase: ComposerPhase): string {
  if (phase === "suspended") return "input locked";
  if (phase === "running") return "Queue a follow-up...";
  return PLACEHOLDER[mode] ?? PLACEHOLDER.agent;
}

export function composerFrame(input: ComposerFrameInput): ComposerFrame {
  const width = Math.max(1, Math.floor(input.columns));
  const textWidth = Math.max(1, width - COMPOSER_CHROME_COLS);
  const showDirectory =
    input.allocatedRows >= COMPOSER_GAP_ROWS + COMPOSER_DIR_ROWS + COMPOSER_BORDER_ROWS + 1;
  const dirRows = showDirectory ? COMPOSER_GAP_ROWS + COMPOSER_DIR_ROWS : 0;
  const budget = Math.max(1, input.allocatedRows - COMPOSER_BORDER_ROWS - dirRows);
  const textRows = resolveComposerTextRows(
    countComposerVisualLines(input.text, textWidth),
    budget,
  );
  const suspended = input.phase === "suspended";

  return {
    width,
    textWidth,
    textRows,
    borderStyle: input.unicode ? "round" : "classic",
    borderColor: suspended ? "muted" : "inputBorder",
    markColor: suspended ? "muted" : "inputBorder",
    mark: input.unicode ? "❯" : ">",
    placeholder: composerPlaceholder(input.mode, input.phase),
    showCaret: !suspended,
    meta: clipComposerMeta(input.metaLabel ?? "", width),
    showDirectory,
  };
}

export function composerTextRowsWanted(input: {
  readonly columns: number;
  readonly text: string;
}): number {
  const textWidth = Math.max(1, Math.floor(input.columns) - COMPOSER_CHROME_COLS);
  return countComposerVisualLines(input.text, textWidth);
}