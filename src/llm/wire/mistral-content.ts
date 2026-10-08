import type { ReasoningArtifact } from "../../types.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
} from "../reasoning-artifacts.js";
import { modelCatalogFacts } from "../capabilities.js";

type ContentChunk = Record<string, unknown>;

function chunkRecord(value: unknown): ContentChunk | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ContentChunk)
    : undefined;
}

export function mistralContentText(content: unknown): {
  text: string;
  reasoning: string;
} {
  if (typeof content === "string") return { text: content, reasoning: "" };
  let text = "";
  let reasoning = "";
  if (Array.isArray(content)) {
    for (const value of content) {
      const chunk = chunkRecord(value);
      if (chunk?.type === "text" && typeof chunk.text === "string")
        text += chunk.text;
      if (chunk?.type === "thinking" && Array.isArray(chunk.thinking)) {
        for (const value of chunk.thinking) {
          const inner = chunkRecord(value);
          if (inner?.type === "text" && typeof inner.text === "string")
            reasoning += inner.text;
        }
      }
    }
  }
  return { text, reasoning };
}

export function mistralReasoningArtifacts(input: {
  content: unknown;
  model: string;
  baseUrl: string;
}): readonly ReasoningArtifact[] | undefined {
  if (
    !Array.isArray(input.content) ||
    !input.content.some((value) => chunkRecord(value)?.type === "thinking")
  )
    return undefined;
  const display = mistralContentText(input.content).reasoning;
  return [
    createReasoningArtifact({
      kind: "structured-details",
      raw: input.content,
      ...(display ? { displaySummary: display } : {}),
      provenance: createReasoningArtifactProvenance({
        provider: "mistral",
        model:
          modelCatalogFacts("mistral", input.model)?.canonicalModel ??
          input.model,
        endpoint: input.baseUrl,
        dialect: "mistral-chat",
      }),
      replay: { scope: "all-history", persistence: "all-turns" },
      position: { sequence: 0, placement: "assistant" },
    }),
  ];
}

function appendText(chunks: ContentChunk[], text: string): void {
  if (!text) return;
  const last = chunks.at(-1);
  if (last?.type === "text" && typeof last.text === "string") last.text += text;
  else chunks.push({ type: "text", text });
}

export class MistralContentAccumulator {
  readonly content: ContentChunk[] = [];

  append(content: unknown): { text: string; reasoning: string } {
    if (typeof content === "string") appendText(this.content, content);
    else if (Array.isArray(content)) {
      for (const value of content) {
        const chunk = chunkRecord(value);
        if (!chunk) continue;
        if (chunk.type === "text" && typeof chunk.text === "string") {
          appendText(this.content, chunk.text);
        } else if (chunk.type === "thinking" && Array.isArray(chunk.thinking)) {
          const last = this.content.at(-1);
          const sameSignature =
            !last?.signature ||
            !chunk.signature ||
            last.signature === chunk.signature;
          const thinking =
            last?.type === "thinking" && sameSignature
              ? last
              : { ...chunk, thinking: [] as ContentChunk[] };
          if (thinking !== last) this.content.push(thinking);
          const inner = thinking.thinking as ContentChunk[];
          for (const value of chunk.thinking) {
            const nested = chunkRecord(value);
            if (!nested) continue;
            if (nested.type === "text" && typeof nested.text === "string")
              appendText(inner, nested.text);
            else inner.push({ ...nested });
          }
          if (typeof chunk.closed === "boolean") thinking.closed = chunk.closed;
          if (typeof chunk.signature === "string")
            thinking.signature = chunk.signature;
        } else {
          this.content.push({ ...chunk });
        }
      }
    }
    return mistralContentText(content);
  }
}
