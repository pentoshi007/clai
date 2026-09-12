import { stripThinking } from "../ui/thinking.js";

export const MAX_TITLE_CHARS = 96;

export function sanitizeTitle(raw: string): string | undefined {
  let title = stripThinking(raw).visible;
  title = title.replace(/^\s*<think(?:ing)?\b[^>]*>[\s\S]*$/i, "");
  title = title.trim();
  if (!title) return undefined;
  title =
    title
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (!title) return undefined;
  title = title.replace(/^(?:title|session|topic|name)\s*[:\-—]\s*/i, "");
  title = title.replace(/^[-*•]\s*/, "");
  title = title.replace(/^["'`“”]+|["'`“”]+$/g, "");
  title = title.replace(/[.,;:!?]+$/, "");
  title = title.replace(/\s+/g, " ").trim();
  if (!title) return undefined;
  const characters = Array.from(title);
  if (characters.length <= MAX_TITLE_CHARS) return title;
  const clipped = characters.slice(0, MAX_TITLE_CHARS - 1).join("");
  const boundary = clipped.lastIndexOf(" ");
  return `${(boundary > MAX_TITLE_CHARS / 2 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
}
