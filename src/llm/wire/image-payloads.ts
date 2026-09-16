import type { ChatImage, ChatMessage, CompletionRequest } from "../../types.js";
import { detectModelImageMediaType } from "../../attachments/image-content.js";

const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;
const SIGNATURE_PROBE_CHARS = 16;

function declaredTypeMatchesPayload(image: ChatImage, head: Uint8Array): boolean {
  const detected = detectModelImageMediaType(head);
  return detected === undefined || detected === image.mediaType.toLowerCase();
}

function isSendableImagePayload(image: ChatImage): boolean {
  const payload = image.dataBase64;
  if (payload.length % 4 !== 0 || !BASE64_ONLY.test(payload)) return false;
  const head = Buffer.from(payload.slice(0, SIGNATURE_PROBE_CHARS), "base64");
  return head.length > 0 && declaredTypeMatchesPayload(image, head);
}

function withoutUnsendableImages(messages: ChatMessage[]): ChatMessage[] {
  let dropped = false;
  const projected = messages.map((message) => {
    const images = message.images;
    if (!images?.length) return message;
    const sendable = images.filter(isSendableImagePayload);
    if (sendable.length === images.length) return message;
    dropped = true;
    const { images: _images, ...rest } = message;
    return sendable.length > 0 ? { ...rest, images: sendable } : rest;
  });
  return dropped ? projected : messages;
}

export function withSendableImages(request: CompletionRequest): CompletionRequest {
  const messages = withoutUnsendableImages(request.messages);
  return messages === request.messages ? request : { ...request, messages };
}
