import { isInternalChatMessage, type ChatMessage } from "../../types.js";
import type { TranscriptItem } from "../ports/transcript-item.js";
import type { SessionPromptInput } from "../../store/session-prompts.js";

export function* legacySessionPrompts(
  messages: readonly ChatMessage[],
  transcript?: readonly TranscriptItem[],
): Generator<SessionPromptInput> {
  let found = false;
  const stack: Iterator<TranscriptItem>[] = transcript ? [transcript[Symbol.iterator]()] : [];
  while (stack.length) {
    const next = stack[stack.length - 1]!.next();
    if (next.done) { stack.pop(); continue; }
    const item = next.value;
    if (item.kind === "compacted") stack.push(item.originalItems[Symbol.iterator]());
    if (item.kind !== "user" || !item.text.trim() ||
        isInternalChatMessage({ role: "user", content: item.text })) continue;
    found = true;
    yield { content: item.text, imported: true };
  }
  if (found) return;
  for (const message of messages) {
    if (message.role === "user" && !isInternalChatMessage(message) && message.content.trim()) {
      yield { content: message.content, imported: true };
    } else if (message.role === "system" && message.compaction) {
      for (const prompt of message.compaction.recentUserPrompts) {
        yield { content: prompt.content, imported: true };
      }
    }
  }
}
