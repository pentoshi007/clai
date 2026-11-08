import { isInternalChatMessage, type ChatImage, type ChatMessage } from "../types.js";
import type { ImageBudget } from "./image-content.js";

export const MAX_RETAINED_IMAGE_COUNT = 6;

export interface ImageRetentionLimits {
  readonly maxCount: number;
  readonly maxTotalBytes: number;
}

export function imageRetentionLimits(
  budget: Pick<ImageBudget, "maxCount" | "maxTotalBytes">,
): ImageRetentionLimits {
  return {
    maxCount: Math.max(0, Math.min(MAX_RETAINED_IMAGE_COUNT, budget.maxCount)),
    maxTotalBytes: Math.max(0, budget.maxTotalBytes),
  };
}

export function imagePayloadBytes(image: ChatImage): number {
  return image.dataBase64 ? Buffer.byteLength(image.dataBase64, "base64") : 0;
}

function payloadBytes(images: readonly ChatImage[]): number {
  return images.reduce((total, image) => total + imagePayloadBytes(image), 0);
}

function releasedImageNote(released: readonly ChatImage[]): string {
  const subject = released.length === 1 ? "1 image" : `${released.length} images`;
  const labels = released.map((image) => image.path ?? "unnamed image").join(", ");
  const object = released.length === 1 ? "it" : "them";
  return (
    `[${subject} no longer attached to this message (${labels}); the pixels are not in context. ` +
    `Call image.view on the path again if you need to look at ${object}.]`
  );
}

function withReleasedImages(message: ChatMessage, released: readonly ChatImage[]): ChatMessage {
  const { images: _images, ...rest } = message;
  const note = releasedImageNote(released);
  return { ...rest, content: message.content ? `${message.content}\n\n${note}` : note };
}

function latestPromptIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && !isInternalChatMessage(message)) return index;
  }
  return -1;
}

export function releaseStaleImages(
  messages: ChatMessage[],
  limits: ImageRetentionLimits,
): number {
  const carriers: number[] = [];
  let totalCount = 0;
  let totalBytes = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const images = messages[index]!.images;
    if (!images?.length) continue;
    carriers.push(index);
    totalCount += images.length;
    totalBytes += payloadBytes(images);
  }
  if (totalCount <= limits.maxCount && totalBytes <= limits.maxTotalBytes) return 0;

  const settledCount = Math.floor(limits.maxCount / 2);
  const settledBytes = Math.floor(limits.maxTotalBytes / 2);
  const pinned = latestPromptIndex(messages);
  const newest = carriers.at(-1);
  let keptCount = 0;
  let keptBytes = 0;
  let releasing = false;
  let released = 0;
  for (let position = carriers.length - 1; position >= 0; position -= 1) {
    const index = carriers[position]!;
    const message = messages[index]!;
    const images = message.images!;
    const bytes = payloadBytes(images);
    const fitsSettled =
      keptCount + images.length <= settledCount && keptBytes + bytes <= settledBytes;
    if (index === pinned || (!releasing && (index === newest || fitsSettled))) {
      keptCount += images.length;
      keptBytes += bytes;
      continue;
    }
    releasing = true;
    messages[index] = withReleasedImages(message, images);
    released += images.length;
  }
  return released;
}
