import { describe, expect, it } from "vitest";
import type { ClipboardPort } from "../../src/app/ports/clipboard-port.js";
import {
  createOsc52ClipboardPort,
  type Osc52RendererPort,
} from "../../src/tui-v2/bootstrap/osc52-clipboard.js";

function fallback(): ClipboardPort & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    async writeText(text) {
      writes.push(text);
    },
  };
}

function renderer(overrides: Partial<Osc52RendererPort> = {}): Osc52RendererPort & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    isOsc52Supported: () => true,
    copyToClipboardOSC52: (text) => {
      writes.push(text);
      return true;
    },
    ...overrides,
  };
}

describe("OSC 52 clipboard adapter (V2-064)", () => {
  it("uses the native renderer path for an enabled supported terminal", async () => {
    const native = renderer();
    const memory = fallback();
    const clipboard = createOsc52ClipboardPort({ renderer: native, fallback: memory, enabled: true });

    await clipboard.writeText("COPY-SENTINEL");

    expect(native.writes).toEqual(["COPY-SENTINEL"]);
    expect(memory.writes).toEqual([]);
    expect(clipboard.lastWrite).toEqual({ method: "osc52" });
  });

  it("uses the explicit fallback when OSC 52 is disabled or unsupported", async () => {
    const native = renderer({ isOsc52Supported: () => false });
    const memory = fallback();
    const disabled = createOsc52ClipboardPort({ renderer: native, fallback: memory, enabled: false });
    const unsupported = createOsc52ClipboardPort({ renderer: native, fallback: memory, enabled: true });

    await disabled.writeText("DISABLED-SENTINEL");
    await unsupported.writeText("UNSUPPORTED-SENTINEL");

    expect(native.writes).toEqual([]);
    expect(memory.writes).toEqual(["DISABLED-SENTINEL", "UNSUPPORTED-SENTINEL"]);
    expect(disabled.lastWrite).toEqual({ method: "fallback", reason: "disabled" });
    expect(unsupported.lastWrite).toEqual({ method: "fallback", reason: "unsupported" });
  });

  it("falls back once when the native renderer rejects or throws", async () => {
    const memory = fallback();
    const rejected = createOsc52ClipboardPort({
      renderer: renderer({ copyToClipboardOSC52: () => false }),
      fallback: memory,
      enabled: true,
    });
    const failed = createOsc52ClipboardPort({
      renderer: renderer({ copyToClipboardOSC52: () => { throw new Error("no OSC"); } }),
      fallback: memory,
      enabled: true,
    });

    await rejected.writeText("REJECTED-SENTINEL");
    await failed.writeText("FAILED-SENTINEL");

    expect(memory.writes).toEqual(["REJECTED-SENTINEL", "FAILED-SENTINEL"]);
    expect(rejected.lastWrite).toEqual({ method: "fallback", reason: "rejected" });
    expect(failed.lastWrite).toEqual({ method: "fallback", reason: "failed" });
  });

  it("bounds OSC 52 payloads and preserves the full text through fallback", async () => {
    const native = renderer();
    const memory = fallback();
    const clipboard = createOsc52ClipboardPort({
      renderer: native,
      fallback: memory,
      enabled: true,
      maxBytes: 4,
    });

    await clipboard.writeText("😀😀");

    expect(native.writes).toEqual([]);
    expect(memory.writes).toEqual(["😀😀"]);
    expect(clipboard.lastWrite).toEqual({ method: "fallback", reason: "too-large" });
  });
});
