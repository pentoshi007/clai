
import { createSystemClipboardPort } from "../../app/adapters/in-memory-clipboard-adapter.js";
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
  readonly method: "osc52" | "fallback" | "system";
  readonly reason?: Osc52FallbackReason;
}

export interface Osc52ClipboardPort extends ClipboardPort {
  readonly lastWrite: Osc52CopyResult | undefined;
}

export interface Osc52ClipboardOptions {
  readonly renderer: Osc52RendererPort;
  readonly fallback: ClipboardPort;
  readonly enabled: boolean;
  readonly maxBytes?: number;
  readonly preferSystem?: boolean;
}

const DEFAULT_MAX_BYTES = 100_000;

export function createTerminalClipboardPort(
  renderer: Osc52RendererPort,
  enabled: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Osc52ClipboardPort {
  const remote = Boolean(env.SSH_TTY || env.SSH_CONNECTION || env.SSH_CLIENT);
  return createOsc52ClipboardPort({ renderer, enabled, preferSystem: !remote, fallback: createSystemClipboardPort("require-system") });
}

export function createOsc52ClipboardPort(options: Osc52ClipboardOptions): Osc52ClipboardPort {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("OSC 52 maxBytes must be a non-negative safe integer");
  }
  let lastWrite: Osc52CopyResult | undefined;
  let pending = Promise.resolve();

  async function writeToClipboard(text: string): Promise<Osc52CopyResult> {
    if (options.preferSystem) {
      try {
        await options.fallback.writeText(text);
        return { method: "system" };
      } catch (error) {
        if (copyWithOsc52(options, text, maxBytes)) throw error;
        return { method: "osc52" };
      }
    }
    const fallbackReason = copyWithOsc52(options, text, maxBytes);
    if (!fallbackReason) return { method: "osc52" };
    await options.fallback.writeText(text);
    return { method: "fallback", reason: fallbackReason };
  }

  return {
    get lastWrite() {
      return lastWrite;
    },
    async readText(): Promise<string | undefined> {
      await pending;
      return options.fallback.readText?.();
    },
    writeText(text: string): Promise<void> {
      const write = pending.then(async () => { lastWrite = await writeToClipboard(text); });
      pending = write.catch(() => undefined);
      return write;
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
