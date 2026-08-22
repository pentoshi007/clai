import type { ChatMessage } from "../types.js";
import { AGENT_INSTRUCTIONS_PREFIX } from "../instructions/load.js";
import { ACTIVE_SKILLS_PREFIX } from "../skills/catalog.js";

export { AGENT_INSTRUCTIONS_PREFIX, ACTIVE_SKILLS_PREFIX };

function upsertKeyed(
  messages: ChatMessage[],
  prefix: string,
  content: string | undefined,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "system" && message.content.startsWith(prefix)) {
      messages.splice(index, 1);
    }
  }
  if (content?.trim()) messages.push({ role: "system", content });
}

export function isAgentInstructionsMessage(content: string): boolean {
  return content.startsWith(AGENT_INSTRUCTIONS_PREFIX);
}

export function isActiveSkillsMessage(content: string): boolean {
  return content.startsWith(ACTIVE_SKILLS_PREFIX);
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
