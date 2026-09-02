import { ProviderError } from "../http.js";
import { readWithAbort } from "./abort-race.js";

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const diff = (date - Date.now()) / 1000;
    if (diff > 0) return diff;
  }
  return undefined;
}

function parseRetryHintFromBody(text: string): number | undefined {
  const match = text.match(/try again in\s+([0-9.]+)\s*s/i);
  if (match) {
    const seconds = Number.parseFloat(match[1]!);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  }
  return undefined;
}

function statusCodeHint(status: number): string {
  if (status === 401) {
    return " — check that the API key is valid (run `clai providers` to inspect)";
  }
  if (status === 403) {
    return " — the key was rejected (insufficient permissions, billing, or region restriction)";
  }
  if (status === 404) {
    return " — endpoint or model not found (try `/model list` to see supported names)";
  }
  if (status === 422) {
    return " — the provider rejected the request body (model name or parameter mismatch)";
  }
  if (status === 413) {
    return " — request exceeded the provider input limit; retry with a compact prompt or pick another model";
  }
  if (status >= 500 && status < 600) {
    return " — upstream provider error; try again or switch with `/provider`";
  }
  return "";
}

export async function readJson<T>(
  response: Response,
  signal?: AbortSignal,
): Promise<T> {
  const text = await readBodyCapped(response, MAX_JSON_RESPONSE_BYTES, signal);
  if (!response.ok) {
    let detail = "";
    let extractedMessage = "";
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const error = (body as { error?: unknown }).error;
      let msg = "";
      if (typeof error === "string") {
        msg = error;
      } else if (error && typeof error === "object") {
        const errObj = error as {
          message?: string;
          type?: string;
          code?: string;
        };
        msg = errObj.message ?? "";
        if (!msg && (errObj.type || errObj.code)) {
          msg = errObj.type ?? errObj.code ?? "";
        }
      }
      if (!msg) {
        msg =
          (body as { message?: string }).message ??
          (body as { detail?: string }).detail ??
          "";
      }
      if (msg) {
        if (/DEGRADED/i.test(msg)) {
          detail = ` — ${msg} (model is temporarily unavailable on this provider; try a different model with \`/model\`)`;
        } else {
          detail = ` — ${msg}`;
        }
      }
      extractedMessage = msg;
    } catch {
    }
    const bodyText = text.slice(0, MAX_ERROR_BODY_CHARS);
    if (bodyAddsInformation(bodyText, extractedMessage)) {
      const shown = collapseWhitespace(bodyText);
      const capped =
        shown.length > MAX_ERROR_BODY_IN_MESSAGE_CHARS
          ? `${shown.slice(0, MAX_ERROR_BODY_IN_MESSAGE_CHARS)}…`
          : shown;
      detail = `${detail} — full response: ${capped}`;
    }
    const retryAfterSeconds =
      parseRetryAfterHeader(response.headers.get("retry-after")) ??
      parseRetryHintFromBody(text);
    const retryHint =
      retryAfterSeconds !== undefined
        ? ` (retry after ${Math.ceil(retryAfterSeconds)}s)`
        : "";
    const codeHint = statusCodeHint(response.status);
    throw new ProviderError(
      `Provider request failed with HTTP ${response.status}${retryHint}${detail}${codeHint}`,
      response.status,
      bodyText,
      retryAfterSeconds,
    );
  }
  return JSON.parse(text) as T;
}

const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

export const MAX_ERROR_BODY_CHARS = 8_000;

export const MAX_ERROR_BODY_IN_MESSAGE_CHARS = 2_000;

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function bodyAddsInformation(
  bodyText: string,
  extracted: string,
): boolean {
  const collapsed = collapseWhitespace(bodyText);
  if (!collapsed) return false;
  if (!extracted) return true;
  const normalizedExtracted = collapseWhitespace(extracted);
  if (normalizedExtracted.includes(collapsed)) return false;
  if (!collapsed.includes(normalizedExtracted)) return true;
  const rest = collapsed
    .replace(normalizedExtracted, " ")
    .replace(/\b(errors?|message|msg|detail|details|type|code|status)\b/gi, " ")
    .replace(/[{}\[\]":,]/g, " ")
    .trim();
  return rest.length > 0;
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Response body read aborted");
    }
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let collected = "";
  let bytesRead = 0;
  const cancelOnAbort = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = signal
        ? await readWithAbort(reader, signal)
        : await reader.read();
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Response body read aborted");
      }
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        collected += decoder.decode(value.subarray(0, remaining), {
          stream: true,
        });
        bytesRead += remaining;
        try {
          await reader.cancel();
        } catch {
        }
        break;
      }
      collected += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
    collected += decoder.decode();
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    try {
      reader.releaseLock();
    } catch {
    }
  }
  return collected;
}
