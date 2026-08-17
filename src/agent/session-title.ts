import { stripThinking } from "../ui/thinking.js";

const MAX_TITLE_CHARS = 64;

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
  return title.length > MAX_TITLE_CHARS
    ? `${title.slice(0, MAX_TITLE_CHARS).trimEnd()}…`
    : title;
}
