import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClipboardPort } from "../../src/app/adapters/in-memory-clipboard-adapter.js";
import { createTerminalClipboardPort } from "../../src/ui-core/ports/clipboard-osc52.js";

const runClipboardCommand = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: runClipboardCommand }));

function terminal(acceptsOsc52 = true) {
  return { isOsc52Supported: () => acceptsOsc52, copyToClipboardOSC52: vi.fn(() => true) };
}

beforeEach(() => {
  runClipboardCommand.mockReset();
});

const text = "exact clipboard paste\n";

describe("terminal clipboard transport", () => {
  it("uses the local system clipboard instead of an unacknowledged terminal escape", async () => {
    const renderer = terminal();
    const clipboard = createTerminalClipboardPort(renderer, true, {});
    runClipboardCommand.mockResolvedValue({ stdout: text });

    await clipboard.writeText(text);
    await expect(clipboard.readText?.()).resolves.toBe(text);

    expect(runClipboardCommand).toHaveBeenNthCalledWith(1, expect.any(String), expect.any(Array), expect.objectContaining({ input: text }));
    expect(renderer.copyToClipboardOSC52).not.toHaveBeenCalled();
    expect(clipboard.lastWrite).toEqual({ method: "system" });
  });

  it("keeps OSC 52 first on SSH so copy reaches the attached client", async () => {
    const renderer = terminal();
    const clipboard = createTerminalClipboardPort(renderer, true, { SSH_TTY: "/dev/pts/2" });

    await clipboard.writeText(text);

    expect(renderer.copyToClipboardOSC52).toHaveBeenCalledExactlyOnceWith(text);
    expect(runClipboardCommand).not.toHaveBeenCalled();
  });

  it("falls back to OSC 52 when all local clipboard commands fail", async () => {
    runClipboardCommand.mockRejectedValue(new Error("clipboard not available"));
    const renderer = terminal();
    const clipboard = createTerminalClipboardPort(renderer, true, {});

    await clipboard.writeText(text);

    expect(renderer.copyToClipboardOSC52).toHaveBeenCalledExactlyOnceWith(text);
    expect(clipboard.lastWrite).toEqual({ method: "osc52" });
  });

  it("does not pretend a failed write reached either clipboard", async () => {
    runClipboardCommand.mockRejectedValue(Object.assign(new Error("no command"), { code: "ENOENT" }));
    const clipboard = createTerminalClipboardPort(terminal(false), true, {});

    await expect(clipboard.writeText(text)).rejects.toThrow(/clipboard is unavailable/i);
    expect(clipboard.lastWrite).toBeUndefined();
    await expect(clipboard.readText?.()).resolves.toBeUndefined();

    const memoryFallback = createSystemClipboardPort();
    await memoryFallback.writeText(text);
    await expect(memoryFallback.readText?.()).resolves.toBe(text);
  });
});
