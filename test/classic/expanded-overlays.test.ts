import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ClassicApp } from "../../src/classic/app/ClassicApp.js";
import { createClassicAppWiring } from "../../src/classic/app/app-wiring.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { overlaySize } from "../../src/ui-core/layout/overlay-size.js";
import { renderColumns } from "../../src/ui-core/rendering/text-width.js";

describe("Classic expanded overlays", () => {
  it.each([[120, 40], [40, 20], [24, 10], [8, 4]])("fills %i by %i without changing the slash completion panel", async (columns, rows) => {
    const services = createCompositionRoot({
      noHistory: true,
      capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns, rows }),
      persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    });
    attachCommandHandlers(services);
    const wiring = createClassicAppWiring({ services, mouse: false, resizeSource: { columns, rows, on() {}, off() {} } });
    await services.commands.dispatch({ name: "orchestrator" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const ui = render(createElement(ServicesProvider, { services, children: createElement(ClassicApp, { wiring }) }));
    try {
      const frame = ui.lastFrame() ?? "";
      if (columns >= 24) expect(frame).toContain("Main agent");
      expect(frame).not.toContain("ctrl+c twice");
      expect(services.session.subagents.enabled).toBe(true);
      for (const line of frame.split("\n")) expect(renderColumns(line)).toBeLessThanOrEqual(columns);
      const size = overlaySize(columns, rows);
      if (columns >= 24) {
        const top = frame.split("\n").findIndex((line) => line.includes("Agents"));
        expect(top).toBe(size.marginY);
        expect(frame.split("\n").filter((line) => line.includes("│")).length).toBe(size.height - 2);
      }
      services.overlay.selectPicker("main");
      expect(services.session.subagents.enabled).toBe(true);
      services.overlay.openPager("Output", "body content\n".repeat(50), undefined, undefined, "plain");
      await new Promise((resolve) => setTimeout(resolve, 60));
      const pager = ui.lastFrame() ?? "";
      if (columns >= 100) expect((pager.match(/c copy/g) ?? []).length).toBe(1);
      expect(pager.split("\n").length).toBeLessThanOrEqual(rows);
      services.overlay.close();
      wiring.composer.paste("/");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(wiring.panels.getSnapshot().kind).toBe("none");
      expect(wiring.getSnapshot().composer.menu.kind).not.toBe("none");
    } finally {
      ui.unmount();
      wiring.dispose();
      services.dispose();
    }
  });
});
