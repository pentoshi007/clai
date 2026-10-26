import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createToolOutputPagerSource } from "../../../src/ui-core/rendering/tool-output-pager-source.js";
import { liveTool } from "../../fixtures/live-pagers.js";
import { createHarness } from "../../classic/app/harness.js";

describe("live tool-output source", () => {
  it("tracks replacements, tolerates a missing final artifact, and unsubscribes on disposal", async () => {
    const h = createHarness();
    const tool = liveTool(h.services);
    const source = createToolOutputPagerSource(h.services, tool.item(), (text) => text || "waiting", 1);
    const subscribe = h.services.transcript.subscribe.bind(h.services.transcript);
    const unsubscribed = vi.fn();
    vi.spyOn(h.services.transcript, "subscribe").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      return () => { unsubscribe(); unsubscribed(); };
    });
    const changed = vi.fn();
    source.watch!(changed);
    try {
      expect((await source.readTail!()).body).toBe("waiting");
      expect(source.commandTone?.()).toBe("running");
      expect(source.regions?.()).toEqual({ inputEnd: 1, inputTone: "running" });
      tool.output("first progress");
      await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0);
      expect(await source.readAll()).toBe("first progress");
      tool.output("replacement progress", true);
      await expect.poll(async () => (await source.readTail!()).body).toBe("replacement progress");
      expect((await source.search("replacement"))?.body).toBe("replacement progress");
      tool.finish("/missing/clai-live-output.log");
      expect(source.isGrowing?.()).toBe(false);
      expect(await source.readAll()).toBe("replacement progress");
      expect(source.commandTone?.()).toBe("success");
      expect(source.regions?.()).toEqual({ inputEnd: 1, inputTone: "success" });
      source.dispose();
      expect(unsubscribed).toHaveBeenCalledOnce();
      await expect(source.readAll()).rejects.toThrow("closed");
    } finally { source.dispose(); h.dispose(); }
  });

  it("keeps command metadata when a live stream switches to the final artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clai-tool-pager-command-"));
    const path = join(dir, "output.log");
    const h = createHarness();
    const tool = liveTool(h.services);
    const command = "printf first\n\nprintf second";
    const source = createToolOutputPagerSource(h.services, tool.item(), (text) => `command: ${command}\n\n${text}`, 3, command);
    try {
      tool.output("stream output");
      expect(await source.readAll()).toContain(`command: ${command}`);
      expect(source.commandText?.()).toBeUndefined();
      await writeFile(path, "final output\n");
      tool.finish(path);
      expect((await source.readPage(0)).body).toBe("final output\n");
      expect(source.commandText?.()).toBe(command);
      expect(source.commandTone?.()).toBe("success");
      expect(source.regions?.()).toBeUndefined();
      expect(await source.readAll()).toBe("final output\n");
    } finally { source.dispose(); h.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it("never reads another session's spool after a switch", async () => {
    const h = createHarness();
    const tool = liveTool(h.services);
    tool.output("original session output");
    const source = createToolOutputPagerSource(h.services, tool.item(), (text) => text);
    try {
      expect(await source.readAll()).toBe("original session output");
      h.services.session.reset({ mintNewId: true });
      h.services.session.spool.replace(tool.item().toolCallId, "different session output");
      expect(source.isGrowing?.()).toBe(false);
      expect(await source.readAll()).toBe("original session output");
    } finally { source.dispose(); h.dispose(); }
  });
});
