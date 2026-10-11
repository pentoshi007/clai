/**
 * Plain-text transcript export (V2-057 / V2-094).
 *
 * Source-order semantic text plus redaction and display sanitize so exports
 * never ship raw API-key shapes or terminal control sequences.
 */

import { redactSecrets } from "../../llm/provider.js";
import type { TranscriptState } from "../../ui-core/state/transcript-types.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { renderTranscriptSemanticText, type TranscriptSemanticOptions } from "./transcript-semantic.js";

export interface TranscriptExportOptions {
  readonly includeThinking?: boolean;
  readonly toolOutput?: TranscriptSemanticOptions["toolOutput"];
}

export function renderTranscriptPlainText(
  state: TranscriptState,
  options: TranscriptExportOptions = {},
): string {
  const raw = renderTranscriptSemanticText(state, {
    thinking: options.includeThinking ? "all" : "none",
    ...(options.toolOutput ? { toolOutput: options.toolOutput } : {}),
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return sanitizeDisplayText(redactSecrets(raw));
}
