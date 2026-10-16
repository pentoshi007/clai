import { createHash } from "node:crypto";
import { redactSecrets } from "../src/llm/provider.js";

export interface EvaluationFailure {
  readonly status: number;
  readonly bodySha256: string;
  readonly message: string | null;
}
export function redactEvaluationText(value: string, sensitiveValues: readonly string[]): string {
  for (const secret of sensitiveValues.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join("[redacted]");
  return redactSecrets(value);
}

export async function evaluationFailure(response: Response, sensitiveValues: readonly string[]): Promise<EvaluationFailure> {
  const reader = response.clone().body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      while (bytes < 8192) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value.slice(0, 8192 - bytes);
        bytes += chunk.length;
        chunks.push(chunk);
      }
    } finally { void reader.cancel().catch(() => {}); }
  }
  const body = Buffer.concat(chunks).toString("utf8");
  let message: string | null = null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = parsed.error;
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") message = error.message;
      else if (typeof error === "string") message = error;
    }
  } catch {}
  if (message !== null) {
    message = redactEvaluationText(message, sensitiveValues).replace(/\s+/g, " ").slice(0, 512);
  }
  return { status: response.status, bodySha256: createHash("sha256").update(body).digest("hex"), message };
}
