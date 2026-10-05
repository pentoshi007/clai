import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";

const active: AppServices[] = [];

function build(requestMinimise: () => boolean): AppServices {
  const services = createCompositionRoot({ provider: "free", noHistory: true, requestMinimise });
  attachCommandHandlers(services);
  active.push(services);
  return services;
}

afterEach(() => {
  for (const services of active.splice(0)) services.dispose();
  vi.restoreAllMocks();
});

describe("minimise commands", () => {
  it.each(["minimise", "minimize", "minmize"])("detaches /%s while persistence is still pending", async (name) => {
    const requestMinimise = vi.fn(() => true);
    const services = build(requestMinimise);
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => { finishSave = resolve; });
    const persist = vi.spyOn(services.session, "persistNow").mockReturnValue(saving);
    const invocation = services.commands.parse(`/${name}`, "composer");
    expect(invocation?.name).toBe("minimise");
    const dispatch = services.commands.dispatch(invocation!);
    try {
      await vi.waitFor(() => expect(requestMinimise).toHaveBeenCalledOnce());
      expect(persist).toHaveBeenCalledOnce();
      expect(await dispatch).toBe(true);
    } finally {
      finishSave();
      await dispatch;
    }
  });

  it("still detaches when saving fails", async () => {
    const requestMinimise = vi.fn(() => true);
    const services = build(requestMinimise);
    vi.spyOn(services.session, "persistNow").mockRejectedValue(new Error("save failed"));
    await services.commands.dispatch({ name: "minimise" });
    expect(requestMinimise).toHaveBeenCalledOnce();
  });

  it("reports when the launch cannot detach", async () => {
    const services = build(() => false);
    const notice = vi.spyOn(services.session, "notice");
    await services.commands.dispatch({ name: "minmize" });
    expect(notice).toHaveBeenCalledWith("warn", expect.stringContaining("background detach is unavailable"));
  });
});
