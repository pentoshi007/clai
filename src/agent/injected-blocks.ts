import type { ChatMessage } from "../types.js";
import { AGENT_INSTRUCTIONS_PREFIX } from "../instructions/load.js";
import { ACTIVE_SKILLS_PREFIX } from "../skills/catalog.js";

export { AGENT_INSTRUCTIONS_PREFIX, ACTIVE_SKILLS_PREFIX };

export function upsertKeyed(
  messages: ChatMessage[],
  prefix: string,
  content: string | undefined,
): void {
  const cleared = `${prefix}\n(cleared)`;
  let sawKeyed = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "system" && message.content.startsWith(prefix)) {
      sawKeyed = true;
      const current = content?.trim() ? content : cleared;
      if (message.content === current) return;
      break;
    }
  }
  if (!sawKeyed && !content?.trim()) return;
  messages.push({ role: "system", content: content?.trim() ? content : cleared });
}

export function isAgentInstructionsMessage(content: string): boolean {
  return (
    content.startsWith(AGENT_INSTRUCTIONS_PREFIX) &&
    !isClearedKeyedBlock(content)
  );
}

export function isActiveSkillsMessage(content: string): boolean {
  return (
    content.startsWith(ACTIVE_SKILLS_PREFIX) &&
    !isClearedKeyedBlock(content)
  );
}

export function isClearedKeyedBlock(content: string): boolean {
  return content.endsWith("\n(cleared)");
}

export function isKeyedBlockMessage(content: string, prefix: string): boolean {
  return content.startsWith(prefix);
}

export function latestKeyedBlock(
  messages: readonly { role: string; content: string }[],
  prefix: string,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "system") continue;
    if (!message.content.startsWith(prefix)) continue;
    return isClearedKeyedBlock(message.content) ? undefined : message.content;
  }
  return undefined;
}

export function upsertAgentInstructionsMessage(
  messages: ChatMessage[],
  block: string | undefined,
): void {
  upsertKeyed(messages, AGENT_INSTRUCTIONS_PREFIX, block);
}

export function upsertActiveSkillsMessage(
  messages: ChatMessage[],
  block: string | undefined,
): void {
  upsertKeyed(messages, ACTIVE_SKILLS_PREFIX, block);
}
