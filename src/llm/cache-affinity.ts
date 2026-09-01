import { createHash } from "node:crypto";

import type { ChatMessage, ProviderId } from "../types.js";

function addMessage(hash: ReturnType<typeof createHash>, message: ChatMessage | undefined): void {
  if (!message) {
    hash.update("-");
    return;
  }
  hash.update(message.role);
  hash.update("\0");
  hash.update(message.content);
  for (const image of message.images ?? []) {
    hash.update("\0");
    hash.update(image.mediaType);
    hash.update("\0");
    hash.update(image.dataBase64);
  }
}

export function cacheAffinityKey(
  provider: ProviderId,
  model: string,
  messages: readonly ChatMessage[],
): string {
  const hash = createHash("sha256");
  hash.update(provider);
  hash.update("\0");
  hash.update(model.trim().toLowerCase());
  hash.update("\0");
  addMessage(hash, messages.find((message) => message.role === "system"));
  hash.update("\0");
  addMessage(hash, messages.find((message) => message.role !== "system"));
  return `clai-${hash.digest("hex").slice(0, 40)}`;
}

export function sessionCacheAffinityKey(sessionId: string): string {
  const hash = createHash("sha256");
  hash.update("clai-session\0");
  hash.update(sessionId);
  return `clai-${hash.digest("hex").slice(0, 40)}`;
}
