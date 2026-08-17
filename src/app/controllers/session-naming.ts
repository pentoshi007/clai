import type { ChatMessage, ProviderId } from "../../types.js";
import { sanitizeTitle } from "../../agent/session-title.js";
import { getConfig, getProviderModel } from "../../store/config.js";
import { completeWithProvider } from "../../llm/router.js";

/**
 * Naming traffic is auxiliary: it keeps its own cache-affinity identity so a
 * short, unrelated prompt can never evict the turn/compaction cached prefix.
 */
export async function completeForSessionNaming(
  messages: ChatMessage[],
  route: { provider?: ProviderId | undefined; model?: string | undefined },
): Promise<string> {
  const config = getConfig();
  const provider = route.provider ?? config.defaultProvider;
  const model = route.model ?? getProviderModel(provider);
  const result = await completeWithProvider({
    provider,
    model,
    purpose: "auxiliary",
    messages,
    temperature: 0.2,
  });
  return result.text;
}

const FIRST_NAMING_AT = 2;
const RENAME_INTERVAL = 3;
const RETRY_INTERVAL = 1;
const MAX_MESSAGE_CHARS = 400;
const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_SUMMARY_CHARS = 1200;

export interface SessionNamingDeps {
  readonly complete: (messages: ChatMessage[]) => Promise<string>;
  readonly applyTitle: (title: string) => void;
  readonly enabled: () => boolean;
}

interface NamingOutcome {
  readonly title: string;
  readonly summary?: string | undefined;
}

function transcriptWindow(
  history: readonly ChatMessage[],
  fromIndex: number,
): string {
  const lines: string[] = [];
  for (let i = Math.max(0, fromIndex); i < history.length; i++) {
    const message = history[i]!;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.internal) continue;
    const text = message.content.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const clipped =
      text.length > MAX_MESSAGE_CHARS
        ? `${text.slice(0, MAX_MESSAGE_CHARS)}…`
        : text;
    lines.push(
      `${message.role === "user" ? "User" : "Assistant"}: ${clipped}`,
    );
  }
  let transcript = lines.join("\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS);
    const firstNewline = transcript.indexOf("\n");
    if (firstNewline > 0) transcript = transcript.slice(firstNewline + 1);
    transcript = `…\n${transcript}`;
  }
  return transcript;
}

function buildNamingMessages(input: {
  previousTitle?: string | undefined;
  previousSummary?: string | undefined;
  transcript: string;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You name chat sessions. Reply with exactly two lines and nothing else:",
        "SUMMARY: <one or two sentences, at most 60 words, summarizing the whole session from the start: merge the previous summary with the new messages and never drop earlier topics>",
        "TITLE: <a short session title of at most 8 words, plain text; keep the same leading words and theme as the previous title while it still fits, refine it only when the topic has shifted>",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Previous title: ${input.previousTitle ?? "(none)"}`,
        `Previous summary: ${input.previousSummary ?? "(none)"}`,
        "",
        "New messages since the last update:",
        input.transcript,
      ].join("\n"),
    },
  ];
}

function parseNamingResponse(raw: string): NamingOutcome | undefined {
  let title: string | undefined;
  let summary: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const summaryMatch = /^summary\s*[:\-—]\s*(.+)$/i.exec(line.trim());
    if (summaryMatch) {
      summary = summaryMatch[1]!.trim();
      continue;
    }
    const titleMatch = /^title\s*[:\-—]\s*(.+)$/i.exec(line.trim());
    if (titleMatch) title = titleMatch[1]!.trim();
  }
  const cleanTitle = title ? sanitizeTitle(title) : undefined;
  if (!cleanTitle) return undefined;
  if (summary && summary.length > MAX_SUMMARY_CHARS) {
    summary = `${summary.slice(0, MAX_SUMMARY_CHARS).trimEnd()}…`;
  }
  return { title: cleanTitle, ...(summary ? { summary } : {}) };
}

export class SessionNamer {
  private userPromptCount = 0;
  private nextNamingAt = FIRST_NAMING_AT;
  private summary: string | undefined;
  private lastTitle: string | undefined;
  private namedMessageCount = 0;
  private inFlight = false;
  private manual = false;

  constructor(private readonly deps: SessionNamingDeps) {}

  noteUserPrompt(userSent: boolean): void {
    if (!userSent) return;
    this.userPromptCount += 1;
  }

  markManual(): void {
    this.manual = true;
  }

  restore(title: string | undefined): void {
    this.userPromptCount = 0;
    this.nextNamingAt = FIRST_NAMING_AT;
    this.summary = undefined;
    this.namedMessageCount = 0;
    this.inFlight = false;
    this.manual = false;
    this.lastTitle = title;
  }

  reset(): void {
    this.restore(undefined);
  }

  maybeRename(history: readonly ChatMessage[]): void {
    if (this.manual || this.inFlight || !this.deps.enabled()) return;
    if (this.userPromptCount < this.nextNamingAt) return;
    this.inFlight = true;
    const snapshot = history.map((message) => ({ ...message }));
    void this.rename(snapshot)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = false;
      });
  }

  private async rename(history: readonly ChatMessage[]): Promise<void> {
    if (history.length < this.namedMessageCount) this.namedMessageCount = 0;
    const fromIndex = this.summary ? this.namedMessageCount : 0;
    const transcript = transcriptWindow(history, fromIndex);
    if (!transcript) {
      this.nextNamingAt = this.userPromptCount + RETRY_INTERVAL;
      return;
    }
    try {
      const raw = await this.deps.complete(
        buildNamingMessages({
          previousTitle: this.lastTitle,
          previousSummary: this.summary,
          transcript,
        }),
      );
      const outcome = parseNamingResponse(raw);
      if (!outcome) {
        this.nextNamingAt = this.userPromptCount + RETRY_INTERVAL;
        return;
      }
      if (outcome.summary) this.summary = outcome.summary;
      this.lastTitle = outcome.title;
      this.namedMessageCount = history.length;
      this.nextNamingAt = this.userPromptCount + RENAME_INTERVAL;
      this.deps.applyTitle(outcome.title);
    } catch {
      this.nextNamingAt = this.userPromptCount + RETRY_INTERVAL;
    }
  }
}
