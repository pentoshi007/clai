/**
 * Generates short, human-friendly titles for chat sessions.
 *
 * The history view is browsed by name, so a raw slice of the first user
 * message ("can you help me fix the…") makes sessions hard to tell apart.
 * Instead we ask the active model for a concise topic title and refresh it
 * as the conversation grows, so the name tracks what the session is actually
 * about rather than just how it opened.
 */

import { completeWithProvider } from "../llm/router.js";
import type { ChatMessage, ProviderId } from "../types.js";

const SYSTEM_PROMPT =
  "You write short titles for developer chat sessions. " +
  "Reply with ONLY the title and nothing else: 3 to 6 words, " +
  "Title Case, no surrounding quotes, no trailing punctuation, " +
  "no prefixes like 'Title:'. Capture the concrete topic or task.";

/** Per-message cap so a few long turns don't blow the prompt budget. */
const PER_MESSAGE_CHARS = 600;
/** Overall transcript cap fed to the title model. */
const TRANSCRIPT_CHARS = 6_000;
/** Hard cap on the stored title length. */
const MAX_TITLE_CHARS = 64;

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Strip the noise models tend to add around a title: reasoning blocks, wrapping
 * quotes, a "Title:" prefix, markdown bullets, trailing punctuation, and any
 * stray second line. Returns `undefined` when nothing usable remains.
 */
export function sanitizeTitle(raw: string): string | undefined {
  let title = raw;
  // Drop any reasoning the model leaked inline (<think>…</think>), including an
  // unclosed block — reasoning models sometimes emit these before the answer.
  title = title.replace(/<think>[\s\S]*?<\/think>/gi, "");
  title = title.replace(/<think>[\s\S]*$/i, "");
  title = title.trim();
  if (!title) return undefined;
  // Keep only the first non-empty line — some models add an explanation below.
  title =
    title
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  if (!title) return undefined;
  // Drop a leading label like "Title:" or "Session:".
  title = title.replace(/^(?:title|session|topic|name)\s*[:\-—]\s*/i, "");
  // Drop list markers and surrounding quotes/backticks.
  title = title.replace(/^[-*•]\s*/, "");
  title = title.replace(/^["'`“”]+|["'`“”]+$/g, "");
  // Drop trailing sentence punctuation.
  title = title.replace(/[.,;:!?]+$/, "");
  title = title.replace(/\s+/g, " ").trim();
  if (!title) return undefined;
  return title.length > MAX_TITLE_CHARS
    ? `${title.slice(0, MAX_TITLE_CHARS).trimEnd()}…`
    : title;
}

function buildTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content?.trim();
    if (!content) continue;
    const who = message.role === "user" ? "User" : "Assistant";
    lines.push(`${who}: ${truncate(content, PER_MESSAGE_CHARS)}`);
  }
  return lines.join("\n").slice(0, TRANSCRIPT_CHARS);
}

export interface TitleContext {
  provider: ProviderId;
  model: string;
  signal?: AbortSignal | undefined;
}

/**
 * Ask the model for a concise title describing the conversation so far.
 * Returns `undefined` when there is nothing to summarize or the request
 * fails — callers should fall back to the existing/derived name.
 */
export async function generateSessionTitle(
  messages: ChatMessage[],
  ctx: TitleContext,
): Promise<string | undefined> {
  const transcript = buildTranscript(messages);
  if (!transcript) return undefined;

  try {
    const result = await completeWithProvider({
      provider: ctx.provider,
      model: ctx.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Write a concise title for this conversation:\n\n${transcript}`,
        },
      ],
      temperature: 0.3,
      // Enough room for a short title even if the model emits a little
      // reasoning. Thinking is disabled so reasoning models don't spend the
      // whole budget on hidden tokens and return an empty visible answer —
      // the bug that left ask-mode (reasoning-heavy) sessions unnamed.
      maxTokens: 256,
      thinking: { enabled: false, effort: "none" },
      signal: ctx.signal,
    });
    return sanitizeTitle(result.text);
  } catch {
    return undefined;
  }
}
