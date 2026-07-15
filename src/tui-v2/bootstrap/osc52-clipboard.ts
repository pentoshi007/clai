/**
 * Renderer-facing OSC 52 clipboard adapter (V2-064).
 *
 * The native renderer performs OSC encoding and terminal writes. This adapter
 * only chooses a bounded, capability-checked path and otherwise delegates to
 * the supplied non-terminal clipboard port.
 */

import type { ClipboardPort } from "../../app/ports/clipboard-port.js";

export interface Osc52RendererPort {
  isOsc52Supported(): boolean;
  copyToClipboardOSC52(text: string): boolean;
}

export type Osc52FallbackReason =
  | "disabled"
  | "unsupported"
  | "too-large"
  | "rejected"
  | "failed";

export interface Osc52CopyResult {
  readonly method: "osc52" | "fallback";
  readonly reason?: Osc52FallbackReason;
}

export interface Osc52ClipboardPort extends ClipboardPort {
  readonly lastWrite: Osc52CopyResult | undefined;
}

export interface Osc52ClipboardOptions {
  readonly renderer: Osc52RendererPort;
  readonly fallback: ClipboardPort;
  readonly enabled: boolean;
  /** Bound terminal payload size; oversized text remains available via fallback. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 100_000;

export function createOsc52ClipboardPort(options: Osc52ClipboardOptions): Osc52ClipboardPort {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("OSC 52 maxBytes must be a non-negative safe integer");
  }
  let lastWrite: Osc52CopyResult | undefined;

  return {
    get lastWrite() {
      return lastWrite;
    },
    async writeText(text: string): Promise<void> {
      const fallbackReason = copyWithOsc52(options, text, maxBytes);
      if (!fallbackReason) {
        lastWrite = { method: "osc52" };
        return;
      }
      await options.fallback.writeText(text);
      lastWrite = { method: "fallback", reason: fallbackReason };
    },
  };
}

function copyWithOsc52(
  options: Osc52ClipboardOptions,
  text: string,
  maxBytes: number,
): Osc52FallbackReason | undefined {
  if (!options.enabled) return "disabled";
  if (Buffer.byteLength(text, "utf8") > maxBytes) return "too-large";
  try {
    if (!options.renderer.isOsc52Supported()) return "unsupported";
    return options.renderer.copyToClipboardOSC52(text) ? undefined : "rejected";
  } catch {
    return "failed";
  }
}
