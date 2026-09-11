import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentManager } from "../../src/agent/subagents/manager.js";
import type { SubagentAssignment, SubagentWorkerInput } from "../../src/agent/subagents/types.js";
import { buildDefaultCommandRegistry } from "../../src/app/commands/registry.js";
import type { AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { createSubagentPagerSource } from "../../src/ui-core/rendering/subagent-source.js";
import { createHarness } from "../classic/panels/harness.js";

const assignment: SubagentAssignment = {
  title: "Inspect tests",
  prompt: "Review the test coverage",
  cwd: process.cwd(),
  provider: "openai",
  model: "test-model",
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  const workers = new Map<string, SubagentWorkerInput>();
  const manager = new SubagentManager("test-parent", {
    worker: (input) => new Promise<string>((resolve) => {
      workers.set(input.run.id, input);
      input.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
    }),
  });
  let current = manager;
  const harness = createHarness();
  const sessionListeners = new Set<() => void>();
  const notice = vi.fn();
  const cancel = vi.fn();
  const commands = buildDefaultCommandRegistry();
  const services = {
    commands,
    overlay: harness.overlay,
    session: {
      get subagents() { return current; },
      getState: () => ({ running: true }),
      notice,
      cancel,
      subscribe(listener: () => void) {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
    },
  } as unknown as AppServices;
  attachCommandHandlers(services);
  cleanups.push(() => {
    harness.overlay.dispose();
    harness.panels.dispose();
    manager.dispose();
    current.dispose();
  });
  return {
    ...harness, manager, workers, notice, cancel, sessionListeners,
    dispatch: (line: string) => commands.dispatch(commands.parse(line)!),
    replaceSession() {
      current = new SubagentManager("next-parent");
      manager.dispose();
      for (const listener of sessionListeners) listener();
    },
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(250);
}

describe("shared orchestration commands", () => {
  it.each(["orchestration", "orchestrator", "orchastrator"])("/%s opens described options and defaults to a non-mutating status action", async (command) => {
    const f = fixture();
    await f.dispatch(`/${command}`);
    expect(f.manager.enabled).toBe(false);
    expect(f.notice).not.toHaveBeenCalled();
    const state = f.overlay.getState();
    expect(state.kind).toBe("picker");
    if (state.kind !== "picker") throw new Error("expected picker");
    expect(state.request.options.map((option) => option.value)).toEqual(["status", "on", "off"]);
    expect(state.request.options.every((option) => option.description)).toBe(true);
    f.press("enter");
    expect(f.manager.enabled).toBe(false);
    expect(f.overlay.getState().kind).toBe("none");
    expect(f.notice).toHaveBeenLastCalledWith("info", expect.stringContaining("Orchestration off"));
    await f.dispatch(`/${command}`);
    f.overlay.selectPicker("on");
    expect(f.manager.enabled).toBe(true);
    await f.dispatch(`/${command}`);
    f.overlay.selectPicker("status");
    expect(f.manager.enabled).toBe(true);
    await f.dispatch(`/${command} off`);
    expect(f.manager.enabled).toBe(false);
  });

  it("does not enable after dismissal or through a stale session picker", async () => {
    const f = fixture();
    await f.dispatch("/orchestrator");
    f.overlay.close();
    expect(f.manager.enabled).toBe(false);
    await f.dispatch("/orchestrator");
    f.replaceSession();
    f.overlay.selectPicker("on");
    expect(f.manager.enabled).toBe(false);
  });

  it("shows default-off status without enabling, validates arguments, and gates restart", async () => {
    const f = fixture();
    await f.dispatch("/orchestration status");
    expect(f.manager.enabled).toBe(false);
    expect(f.notice).toHaveBeenLastCalledWith("info", expect.stringContaining("Orchestration off"));
    await f.dispatch("/orchestration invalid");
    expect(f.notice).toHaveBeenLastCalledWith("warn", expect.stringContaining("usage:"));
    await f.dispatch("/orchestration on");
    const run = f.manager.start(assignment);
    await flush();
    await f.dispatch("/orchestration status");
    expect(f.manager.enabled).toBe(true);
    await f.dispatch("/orchestration off");
    expect(f.workers.get(run.id)!.signal.aborted).toBe(true);
    await f.dispatch(`/agents restart ${run.id}`);
    expect(f.notice).toHaveBeenLastCalledWith("warn", expect.stringContaining("Orchestration is off"));
    await flush();
    await f.dispatch("/orchestration on");
    await f.dispatch(`/agents restart ${run.id}`);
    expect(f.manager.get(run.id)?.attempt).toBe(2);
    await f.dispatch(`/agents stop ${run.id}`);
    await flush();
    expect(f.manager.get(run.id)?.status).toBe("stopped");
    await f.dispatch("/agents missing");
    expect(f.notice).toHaveBeenLastCalledWith("warn", "Unknown subagent: missing");
    await f.dispatch("/agents stop");
    expect(f.notice).toHaveBeenLastCalledWith("warn", expect.stringContaining("usage:"));
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it("switches live children through a retained picker and returns to main without cancellation", async () => {
    const f = fixture();
    await f.dispatch("/orchestration on");
    const first = f.manager.start(assignment);
    const second = f.manager.start({ ...assignment, title: "Inspect source", prompt: "Review the source implementation" });
    await flush();
    await f.dispatch("/agents");
    expect(f.panels.getSnapshot().kind).toBe("picker");
    f.overlay.selectPicker(first.id);
    await flush();
    expect(f.panels.getSnapshot().pager.follow).toBe(true);
    f.workers.get(first.id)!.emit({ kind: "assistant", text: "first live finding" });
    await flush();
    expect(f.panels.getSnapshot().pagerBody).toContain("first live finding");
    f.press("l", "l");
    f.workers.get(first.id)!.emit({ kind: "tool", text: "paused output" });
    await flush();
    expect(f.panels.getSnapshot().pagerBody).not.toContain("paused output");
    f.press("l", "l");
    await flush();
    expect(f.panels.getSnapshot().pagerBody).toContain("paused output");
    f.overlay.close();
    expect(f.panels.getSnapshot().kind).toBe("picker");
    f.overlay.selectPicker(second.id);
    f.workers.get(second.id)!.emit({ kind: "assistant", text: "second live finding" });
    await flush();
    expect(f.panels.getSnapshot().pagerBody).toContain("second live finding");
    expect(f.panels.getSnapshot().pagerBody).not.toContain("first live finding");
    f.overlay.close();
    f.overlay.selectPicker("main");
    expect(f.overlay.getState().kind).toBe("none");
    expect(f.sessionListeners.size).toBe(0);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.manager.get(first.id)?.status).toBe("running");
    expect(f.manager.get(second.id)?.status).toBe("running");
  });

  it("refreshes status on returning from a child and fences inspection on session replacement", async () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const run = f.manager.start(assignment);
    await flush();
    await f.dispatch("/agents");
    f.overlay.selectPicker(run.id);
    f.manager.stop(run.id);
    await flush();
    expect(f.panels.getSnapshot().pagerBody).toContain("stopped");
    expect(f.panels.getSnapshot().pager.follow).toBe(false);
    f.overlay.close();
    const picker = f.overlay.getState();
    expect(picker.kind).toBe("picker");
    if (picker.kind === "picker") {
      expect(picker.request.options.find((option) => option.value === run.id)?.label).toContain("stopped");
    }
    f.overlay.selectPicker(run.id);
    f.replaceSession();
    expect(f.overlay.getState().kind).toBe("none");
    expect(f.sessionListeners.size).toBe(0);
  });

  it("opens an empty picker and direct child views with complete cleanup", async () => {
    const f = fixture();
    await f.dispatch("/agents");
    const state = f.overlay.getState();
    expect(state.kind === "picker" && state.request.options.map((o) => o.value)).toEqual(["main"]);
    f.overlay.close();
    f.manager.setEnabled(true);
    const run = f.manager.start(assignment);
    await f.dispatch(`/agents ${run.id}`);
    expect(f.overlay.getState().kind).toBe("pager");
    f.overlay.close();
    expect(f.overlay.getState().kind).toBe("none");
    expect(f.sessionListeners.size).toBe(0);
  });

  it("throttles source events, reads updated tails, and removes subscriptions on disposal", async () => {
    const f = fixture();
    f.manager.setEnabled(true);
    const run = f.manager.start(assignment);
    await flush();
    const source = createSubagentPagerSource(f.manager, run.id, 1024);
    const changed = vi.fn();
    source.watch!(changed);
    const input = f.workers.get(run.id)!;
    for (let i = 0; i < 20; i++) input.emit({ kind: "assistant", text: `chunk ${i}\n`, append: true });
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await source.readTail!()).body).toContain("chunk 19");
    source.dispose();
    input.emit({ kind: "assistant", text: "after disposal" });
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(source.isGrowing!()).toBe(false);
  });
});
