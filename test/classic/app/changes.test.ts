import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { hydrateFromClassicTranscript } from "../../../src/ui-core/state/transcript-hydrate.js";
import { createHarness } from "./harness.js";
import { savedChanges, savedChangeTranscript } from "../../fixtures/session-changes.js";

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
});
