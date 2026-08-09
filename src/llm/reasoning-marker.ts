export const REASONING_OPEN = "\ue000";
export const REASONING_CLOSE = "\ue001";

const REASONING_MARKERS = /[\ue000\ue001]/g;

export function wrapReasoning(reasoning: string): string {
  return `${REASONING_OPEN}${reasoning}${REASONING_CLOSE}`;
}

export function stripReasoningMarkers(text: string): string {
  return text.includes(REASONING_OPEN) || text.includes(REASONING_CLOSE)
    ? text.replace(REASONING_MARKERS, "")
    : text;
}

export function hasReasoningMarker(text: string): boolean {
  return text.includes(REASONING_OPEN) || text.includes(REASONING_CLOSE);
}
