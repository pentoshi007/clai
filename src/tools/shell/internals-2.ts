

/**
 * Re-read a freshly written artifact, run it through the same redactor
 * the model-facing output uses, and write it back atomically. This is a
 * defense-in-depth measure: live capture is unavoidable byte-by-byte, so
 * we redact post-hoc the moment the child closes, before any reader
 * (user, model, or `/output last`) gets a chance to see the raw bytes.
 *
 * Returns whether the artifact was rewritten. Any error is swallowed — a
 * raw artifact is still better than an inaccessible one, and the model
 * never receives the unredacted content (that path runs through
 * redactSecrets() too).
 */
/** Skip full-file redaction above this size (avoids multi‑hundred‑MB heap spikes). */
export const MAX_REDACT_IN_MEMORY_BYTES = 8 * 1024 * 1024;

export const NO_MATCH_EXIT_COMMANDS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "rg",
  "findstr",
  "ack",
  "ag",
  "diff",
  "diff3",
  "cmp",
  "comm",
  "test",
  "[",
]);

export function finalPipelineStageName(command: string): string | undefined {
  const lastInChain = command.split(/;|&&|\|\|/).pop() ?? "";
  const lastStage = lastInChain.split("|").pop() ?? "";
  const tokens = lastStage.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (
    index < tokens.length &&
    (tokens[index] === "sudo" ||
      tokens[index] === "command" ||
      tokens[index] === "builtin" ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!))
  ) {
    index += 1;
  }
  const first = tokens[index];
  if (!first) return undefined;
  return first.split("/").pop();
}
