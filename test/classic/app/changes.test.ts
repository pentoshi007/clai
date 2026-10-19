import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { hydrateFromClassicTranscript } from "../../../src/ui-core/state/transcript-hydrate.js";
import { createHarness } from "./harness.js";
import { diffedChangeTranscript, largeChangeTranscript, savedChanges, savedChangeTranscript } from "../../fixtures/session-changes.js";

describe("Classic session changes", () => {
  it.each([120, 80, 40])("renders saved run totals and /changes at %s columns", async (columns) => {
    const h = createHarness({ columns, rows: 35, commands: true });
    h.services.session.loadHistory([], { sessionId: `saved-change-${columns}`, changes: savedChanges });
    h.services.transcript.hydrate(hydrateFromClassicTranscript(savedChangeTranscript).state);
    const view = render(createElement(ServicesProvider, {
      services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }),
    }));
    const frame = () => view.lastFrame()?.replace(/[│║]/g, "").replace(/\s+/g, " ") ?? "";
    try {
      await expect.poll(frame).toContain("Worked for 1m16s · +213 -435");
      await expect.poll(frame).toContain("Worked for 5.0s · aborted · +5 -1");
      expect(frame()).toContain("Worked for 2.0s");
      expect(frame()).not.toContain("Worked for 2.0s · +");
      h.wiring.composer.setText("/changes");
      h.wiring.handleData("\r");
      await expect.poll(frame).toContain("Session changes");
      await expect.poll(frame).toContain("+218 -436");
      await expect.poll(frame).toContain("+200 -400");
      const body = h.services.overlay.getState();
      if (body.kind === "pager") expect(await body.source!.readAll()).toContain(savedChanges[0]!.path);
      h.wiring.handleData("\x1b[F");
      await expect.poll(frame).toContain("+18 -36 src/old.ts");
      h.wiring.handleData("q");
      await expect.poll(frame).not.toContain("Session changes");
      h.services.session.reset({ mintNewId: true });
      h.services.transcript.reset();
      await expect.poll(frame).not.toContain("Worked for");
      h.wiring.composer.setText("/changes");
      await expect.poll(frame).toContain("/changes");
      h.wiring.handleData("\r");
      await expect.poll(frame).toContain("No line changes recorded in this session.");
      expect(frame()).not.toContain("+218 -436");
    } finally { view.unmount(); h.dispose(); }
  });

  it.each([120, 60])("lists each changed file's counts and full diff below the summary at %s columns", async (columns) => {
    const h = createHarness({ columns, rows: 40, commands: true });
    h.services.session.loadHistory([], { sessionId: `diffed-change-${columns}`, transcript: diffedChangeTranscript });
    h.services.transcript.hydrate(hydrateFromClassicTranscript(diffedChangeTranscript).state);
    const view = render(createElement(ServicesProvider, {
      services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }),
    }));
    const frame = () => view.lastFrame()?.replace(/[│║]/g, "").replace(/\s+/g, " ") ?? "";
    try {
      h.wiring.composer.setText("/changes");
      h.wiring.handleData("\r");
      await expect.poll(frame).toContain("Session changes");
      await expect.poll(frame).toContain("+1 -1 /repo/src/answer.ts");
      await expect.poll(frame).toContain("+2 -0 /repo/tools/run.py");
      const pager = h.services.overlay.getState();
      expect(pager.kind === "pager" && pager.source?.diffLines).toBe(true);
      h.wiring.handleData("\x1b[F");
      await expect.poll(frame).toContain("edit · /repo/src/answer.ts");
      await expect.poll(frame).toContain("7 - const v6 = 6;");
      await expect.poll(frame).toContain("7 + const answer = 42;");
      await expect.poll(frame).toContain("create · /repo/tools/run.py");
      await expect.poll(frame).toContain("1 + def run():");
      expect(frame()).not.toContain("diff not kept");
    } finally { view.unmount(); h.dispose(); }
  });

  it("keeps a /changes body far larger than one artifact page in a single continuous view", async () => {
    const transcript = largeChangeTranscript(120);
    const h = createHarness({ columns: 100, rows: 30, commands: true });
    h.services.session.loadHistory([], { sessionId: "large-changes", transcript });
    h.services.transcript.hydrate(hydrateFromClassicTranscript(transcript).state);
    const view = render(createElement(ServicesProvider, {
      services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }),
    }));
    const frame = () => view.lastFrame()?.replace(/[│║]/g, "").replace(/\s+/g, " ") ?? "";
    try {
      h.wiring.composer.setText("/changes");
      h.wiring.handleData("\r");
      await expect.poll(frame).toContain("Session changes");
      const pager = h.services.overlay.getState();
      expect(pager.kind).toBe("pager");
      if (pager.kind !== "pager") return;
      const body = await pager.source!.readAll();
      expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024);
      await expect.poll(() => h.wiring.panels.getSnapshot().pagerBody).toBe(body);
      h.wiring.handleData("\x1b[F");
      await expect.poll(frame).toContain("60 + export const FILE_99_LINE_59 = 59;");
      h.wiring.handleData("\x1b[H");
      await expect.poll(frame).toContain("Total · +7200 -0 · 120 files");
    } finally { view.unmount(); h.dispose(); }
  }, 60_000);
});
