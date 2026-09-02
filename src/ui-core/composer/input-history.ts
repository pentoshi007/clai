import { isKnownSlashCommand } from "../../app/commands/catalog.js";

export function shouldStoreInPromptHistory(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !(trimmed.startsWith("/") && isKnownSlashCommand(trimmed));
}
