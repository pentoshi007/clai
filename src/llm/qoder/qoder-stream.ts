import { ProviderError, createSseFrameAssembler, readStreamLines, streamIdleBudgets } from "../http.js";
import { parseOpenAiUsage } from "../token-usage.js";
import { extractQoderStreamBody } from "./qoder-response.js";

interface QoderStreamDelta {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  thinking?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string | Record<string, unknown> };
  }>;
}

interface QoderStreamChunk {
  choices?: Array<{ delta?: QoderStreamDelta; finish_reason?: string }>;
  usage?: unknown;
}

const USAGE_TAIL_TIMEOUT_MS = 5_000;

function parseChunk(raw: string): QoderStreamChunk {
  try {
    const chunk: QoderStreamChunk = JSON.parse(raw);
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) throw new Error("Invalid stream chunk");
    if (chunk.choices !== undefined && !Array.isArray(chunk.choices)) throw new Error("Invalid stream choices");
    return chunk;
  } catch {
    throw new ProviderError("Qoder returned malformed stream data.", 502, raw.slice(0, 2000));
  }
}

export async function* readQoderStreamChunks(
  response: Response,
  reasoningEnabled: boolean,
  outputProgress: () => number,
  signal?: AbortSignal,
): AsyncGenerator<QoderStreamChunk, void, void> {
  const tailController = new AbortController();
  const streamSignal = signal ? AbortSignal.any([signal, tailController.signal]) : tailController.signal;
  let tailTimer: NodeJS.Timeout | undefined;
  let finished = false;
  const frames = createSseFrameAssembler();
  try {
    for await (const line of readStreamLines(response, {
      signal: streamSignal,
      ...streamIdleBudgets(reasoningEnabled),
      outputProgress,
    })) {
      const payload = frames.pushLine(line);
      if (!payload) continue;
      if (payload === "[DONE]") { finished = true; break; }
      const raw = extractQoderStreamBody(payload);
      if (!raw) continue;
      if (raw === "[DONE]") { finished = true; break; }
      if (/^\[(?:NOT_EXCEED_QUOTA|EXCEED_QUOTA|NOTIFICATIONS)\]/.test(raw)) continue;
      const chunk = parseChunk(raw);
      if (finished) {
        if (parseOpenAiUsage(chunk.usage)) { yield { usage: chunk.usage }; break; }
        continue;
      }
      yield chunk;
      if (!chunk.choices?.[0]?.finish_reason) continue;
      finished = true;
      if (parseOpenAiUsage(chunk.usage)) break;
      tailTimer = setTimeout(() => tailController.abort(new DOMException("Qoder usage trailer timed out.", "TimeoutError")), USAGE_TAIL_TIMEOUT_MS);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!finished) throw error;
  } finally {
    if (tailTimer) clearTimeout(tailTimer);
  }
  if (!finished) throw new ProviderError("Qoder stream ended before completion.", 502);
}
