
/** True when tool output is a protocol-repair placeholder, not live work. */
export function isProtocolPlaceholderOutput(output: string | undefined): boolean {
  if (!output) return false;
  return (
    // Current marker (tool-history formatProtocolPlaceholder).
    output.includes("[context-note]") ||
    /^\[context-note\]/i.test(output.trim()) ||
    // Legacy markers still present in older session histories.
    output.includes("[protocol] closed incomplete") ||
    output.includes("[internal-pairing]") ||
    output.includes("history-repair") ||
    /^\[protocol\]/i.test(output.trim()) ||
    /^\[internal-pairing\]/i.test(output.trim())
  );
}

export function codingSessionFromContext(input: {
  buildLike: boolean;
  planKind?: string | undefined;
}): boolean {
  const kind = (input.planKind ?? "").toLowerCase();
  return input.buildLike || kind === "coding";
}
