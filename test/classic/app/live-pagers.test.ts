import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { openToolOutputPager } from "../../../src/ui-core/rendering/open-tool-output.js";
import { liveJob, liveTool, numberedOutput } from "../../fixtures/live-pagers.js";
import { createHarness } from "./harness.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const artifact = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "clai-live-pager-"));
  dirs.push(dir);
  return join(dir, "output.log");
};

function mount(h: ReturnType<typeof createHarness>) {
  const view = render(createElement(ServicesProvider, {
    services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }),
  }));
  return { view, frame: () => view.lastFrame()?.replace(/[│║]/g, "").replace(/\s+/g, " ") ?? "" };
}

describe("Classic live pagers", () => {
  it("streams tool output, preserves a paused reader, resumes following, and settles on the final artifact", async () => {
    const h = createHarness({ rows: 24 });
    const tool = liveTool(h.services);
    tool.output(numberedOutput(45));
    const { view, frame } = mount(h);
    try {
      await openToolOutputPager(h.services, tool.item());
      await expect.poll(frame).toContain("stream line 45");
      h.wiring.handleData("g");
      await expect.poll(frame).toContain("stream line 1");
      tool.output("\nAPPENDED_WHILE_PAUSED");
      await expect.poll(() => h.wiring.panels.getSnapshot().pagerBody).toContain("APPENDED_WHILE_PAUSED");
      expect(h.wiring.panels.getSnapshot().pager.follow).toBe(false);
      expect(frame()).toContain("stream line 1");
      expect(frame()).not.toContain("APPENDED_WHILE_PAUSED");
      h.wiring.handleData("l");
      await expect.poll(frame).toContain("APPENDED_WHILE_PAUSED");
      const path = artifact();
      writeFileSync(path, `${numberedOutput(45)}\nFINAL_ARTIFACT_OUTPUT`);
      const state = h.services.overlay.getState();
      expect(state.kind).toBe("pager");
      if (state.kind !== "pager") return;
      const dispose = vi.spyOn(state.source!, "dispose");
      tool.finish(path);
      await expect.poll(frame).toContain("FINAL_ARTIFACT_OUTPUT");
      await expect.poll(() => h.wiring.panels.getSnapshot().pager.follow).toBe(false);
      h.wiring.handleData("q");
      expect(dispose).toHaveBeenCalledOnce();
      expect(h.services.overlay.getState().kind).toBe("none");
    } finally { view.unmount(); h.dispose(); }
  });

  it.each(["t", "v", "\r"])("opens live job output with %j and observes disk writes without job events", async (key) => {
    const path = artifact();
    writeFileSync(path, numberedOutput(45));
    const job = liveJob(path);
    const h = createHarness({ rows: 24, jobs: job.port });
    const { view, frame } = mount(h);
    try {
      h.services.overlay.openJobs();
      await expect.poll(frame).toContain("Background jobs");
      const subscriptions = job.listeners();
      h.wiring.handleData(key);
      await expect.poll(frame).toContain("stream line 45");
      appendFileSync(path, "\nDISK_ONLY_APPEND");
      await expect.poll(frame).toContain("DISK_ONLY_APPEND");
      h.wiring.handleData("g");
      await expect.poll(frame).toContain("stream line 1");
      appendFileSync(path, "\nPAUSED_DISK_APPEND");
      await expect.poll(() => h.wiring.panels.getSnapshot().pagerBody).toContain("PAUSED_DISK_APPEND");
      expect(frame()).not.toContain("PAUSED_DISK_APPEND");
      job.update({ status: "exited", exitCode: 0 });
      await expect.poll(() => h.wiring.panels.getSnapshot().pager.follow).toBe(false);
      expect(frame()).toContain("stream line 1");
      h.wiring.handleData("l");
      await expect.poll(frame).toContain("PAUSED_DISK_APPEND");
      h.wiring.handleData("q");
      await expect.poll(frame).toContain("Background jobs");
      expect(job.listeners()).toBe(subscriptions);
      h.wiring.handleData("q");
    } finally { view.unmount(); h.dispose(); expect(job.listeners()).toBe(0); }
  });
});
