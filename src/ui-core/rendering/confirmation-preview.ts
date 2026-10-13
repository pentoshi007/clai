import type { ConfirmRequest } from "../controllers/overlay-controller.js";
import { fitOneLine, wrapPagerLine } from "./pager-chrome.js";
import { sanitizeDisplayText } from "./sanitize-display.js";

export const CONFIRM_CONTENT_MAX_ROWS = 9;
const PROMPT_MAX_ROWS = 6;
const REASON_MAX_ROWS = 3;

export function wrapConfirmationText(text: string, columns: number): string[] {
  const safe = sanitizeDisplayText(text).replace(/\r/g, "").replace(/\t/g, "    ").trim();
  return safe.split("\n").flatMap((line) =>
    wrapPagerLine(line, Math.max(1, columns), { preserveWhitespace: true }),
  );
}

export interface ConfirmationPreview {
  readonly reasonLines: readonly string[];
  readonly promptLines: readonly string[];
  readonly hiddenPromptRows: number;
}

export function confirmationPreview(
  request: ConfirmRequest,
  columns: number,
  maxRows = CONFIRM_CONTENT_MAX_ROWS,
): ConfirmationPreview {
  const budget = Math.max(0, Math.floor(maxRows));
  const reason = request.reason ? wrapConfirmationText(`Reason: ${request.reason}`, columns) : [];
  const reasonCap = Math.min(reason.length, REASON_MAX_ROWS, Math.max(budget > 0 ? 1 : 0, budget - 2));
  const reasonLines = reason.slice(0, reasonCap);
  if (reasonLines.length > 0 && reasonCap < reason.length) {
    const last = reasonLines.length - 1;
    reasonLines[last] = fitOneLine([`${reasonLines[last]}…`], columns);
  }

  const prompt = wrapConfirmationText(request.prompt, columns);
  const promptCap = Math.min(PROMPT_MAX_ROWS, Math.max(0, budget - reasonLines.length));
  const truncated = prompt.length > promptCap;
  const kept = Math.max(0, promptCap - (truncated ? 1 : 0));
  const promptLines = prompt.slice(0, kept);
  const hiddenPromptRows = Math.max(0, prompt.length - promptLines.length);
  if (truncated && promptCap > 0) {
    const more = `… ${hiddenPromptRows} more line${hiddenPromptRows === 1 ? "" : "s"}`;
    promptLines.push(request.review
      ? fitOneLine([`${more} · ctrl+o view full`, "… ctrl+o view full", "… ^O full", "…"], columns)
      : fitOneLine([more, "…"], columns));
  }
  return { reasonLines, promptLines, hiddenPromptRows };
}
