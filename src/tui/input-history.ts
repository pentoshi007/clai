import { isKnownSlashCommand } from "../repl.js";

/** Composer history is for user prompts, not TUI control commands. */
export function shouldStoreInPromptHistory(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !(trimmed.startsWith("/") && isKnownSlashCommand(trimmed));
}
