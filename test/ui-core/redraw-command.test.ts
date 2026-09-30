import { describe, expect, it, vi } from "vitest";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";

function build(requestRedraw?: () => boolean) {
  const services = createCompositionRoot({
    noHistory: true,
    requestRedraw,
    persistence: {
      async saveSession() {},
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    },
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 100,
      rows: 30,
    }),
  });
  attachCommandHandlers(services);
  return services;
}

describe("/redraw", () => {
  it("asks the active frontend to repaint", async () => {
    const requestRedraw = vi.fn(() => true);
    const services = build(requestRedraw);
    expect(await services.commands.dispatch({ name: "redraw", args: "" })).toBe(true);
    expect(requestRedraw).toHaveBeenCalledTimes(1);
    services.dispose();
  });

  it("is also reachable as /refresh", () => {
    const services = build();
    expect(services.commands.parse("/refresh", "composer")?.name).toBe("redraw");
    services.dispose();
  });

  it("says so when the frontend cannot repaint", async () => {
    const services = build(() => false);
    const notices: string[] = [];
    const notice = vi.spyOn(services.session, "notice").mockImplementation((_level, text) => {
      notices.push(String(text));
    });
    await services.commands.dispatch({ name: "redraw", args: "" });
    expect(notices).toEqual(["screen redraw is unavailable in this launch"]);
    notice.mockRestore();
    services.dispose();
  });
});
