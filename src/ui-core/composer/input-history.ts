import { isKnownSlashCommand } from "../../app/commands/catalog.js";
import { isBlankInput, splitCommandInput } from "../../app/commands/command-input.js";

export function shouldStoreInPromptHistory(text: string): boolean {
  if (isBlankInput(text)) return false;
  const command = splitCommandInput(text);
  return !(command && isKnownSlashCommand(`/${command.token}`));
}
