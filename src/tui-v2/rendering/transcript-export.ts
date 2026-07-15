/**
 * Plain-text transcript export (V2-057 / V2-094).
 *
 * Source-order semantic text plus redaction and display sanitize so exports
 * never ship raw API-key shapes or terminal control sequences.
 */

import { redactSecrets } from "../../llm/provider.js";
import type { TranscriptState } from "../state/transcript-types.js";
import { sanitizeDisplayText } from "./sanitize-display.js";
import { renderTranscriptSemanticText } from "./transcript-semantic.js";

export interface TranscriptExportOptions {
  readonly includeThinking?: boolean;
}

export function renderTranscriptPlainText(
  state: TranscriptState,
  options: TranscriptExportOptions = {},
): string {
  const raw = renderTranscriptSemanticText(state, {
    thinking: options.includeThinking ? "all" : "none",
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sanitizeDisplayText(redactSecrets(raw));
}
