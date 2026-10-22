import { redactSecrets } from "../llm/provider.js";
import { sanitizeDisplayText } from "../ui-core/rendering/sanitize-display.js";

const RECOVERY: Readonly<Record<string, string>> = {
  EDQUOT: "Storage quota exceeded (EDQUOT). Free space in the affected location or choose a writable TMPDIR; the disk may still have free space.",
  ENOSPC: "Storage is full (ENOSPC). Free disk space or inodes, or choose another storage location.",
  EACCES: "Permission denied (EACCES). Check access to the affected configuration, history, or output directory.",
  EPERM: "Operation not permitted (EPERM). Check permissions for the affected file or directory.",
  EMFILE: "Too many open files (EMFILE). Close unused processes or raise the open-file limit.",
  ENFILE: "The system open-file limit was reached (ENFILE). Close unused processes or raise that limit.",
  ENOMEM: "Not enough memory (ENOMEM). Close memory-heavy processes or reduce concurrent work.",
};

export function runtimeErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === "object") {
      const code = "code" in current ? String(current.code) : undefined;
      if (code && RECOVERY[code]) return code;
      const message = "message" in current ? String(current.message) : "";
      const match = /\b(EDQUOT|ENOSPC|EACCES|EPERM|EMFILE|ENFILE|ENOMEM)\b/.exec(message);
      if (match) return match[1];
      current = "cause" in current ? current.cause : undefined;
    } else {
      return /\b(EDQUOT|ENOSPC|EACCES|EPERM|EMFILE|ENFILE|ENOMEM)\b/.exec(String(current))?.[1];
    }
  }
  return undefined;
}

export function formatRuntimeError(error: unknown): string {
  const code = runtimeErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const detail = sanitizeDisplayText(redactSecrets(message));
  return (code ? `${RECOVERY[code]}\n${detail}` : detail).slice(0, 1_000);
}
