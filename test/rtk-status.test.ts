import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateConfig } from "../src/store/config.js";
import { createRtkExecutionRecorder } from "../src/store/rtk-usage.js";
import { detectRtk, readRtkGain, type RtkGain } from "../src/tools/rtk/binary.js";
import { createCompositionRoot, type AppServices } from "../src/ui-core/bootstrap/composition-root.js";
import { handleRtk } from "../src/ui-core/commands/rtk-commands.js";

vi.mock("../src/tools/rtk/binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/rtk/binary.js")>()),
  detectRtk: vi.fn(),
  readRtkGain: vi.fn(),
}));

const ready = { state: "ready", path: "/opt/bin/rtk", version: "0.51.0" } as const;
const gain: RtkGain = { commands: 800, savedTokens: 1_486_906, savingsPct: 82.54457661170564 };
let services: AppServices;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const invoke = (args = ""): Promise<void> | void =>
  handleRtk(services, { name: "rtk", args, context: "global" });

function picker() {
  const state = services.overlay.getState();
  if (state.kind !== "picker") throw new Error(`Expected picker, got ${state.kind}`);
  return state;
}

function description(): string {
  return picker().request.options.find((option) => option.value === "refresh")!.description!;
}

async function open(): Promise<void> {
  await invoke();
  await settle();
}

beforeEach(() => {
  vi.mocked(detectRtk).mockReset().mockResolvedValue(ready);
  vi.mocked(readRtkGain).mockReset().mockResolvedValue(gain);
  updateConfig({ rtk: true });
  services = createCompositionRoot({ noHistory: true, sessionId: `rtk-status-${randomUUID()}` });
});

afterEach(() => {
  services.dispose();
  vi.restoreAllMocks();
});

describe("/rtk statistics", () => {
  it.each(["picker", "status"])("identifies estimated session savings in %s", async (surface) => {
    const notice = vi.spyOn(services.session, "notice");
    createRtkExecutionRecorder(services.session.sessionId)();
    if (surface === "picker") await open();
    else await invoke("status");
    const text = surface === "picker" ? description() : notice.mock.calls[0]![1];
    expect(text).toContain("1 automatic RTK run this session");
    expect(readRtkGain).toHaveBeenCalledWith(ready.path, services.session.sessionId);
    expect(text).not.toContain("globally");
    expect(text).toContain("1.5M estimated tokens saved this session (83%)");
    expect(text).not.toContain("command compressed");
    if (surface === "picker") expect(text).toContain("select to refresh");
  });

  it.each(["picker", "status"])("reports unavailable statistics, not empty history, in %s", async (surface) => {
    vi.mocked(readRtkGain).mockResolvedValue(undefined);
    const notice = vi.spyOn(services.session, "notice");
    if (surface === "picker") await open();
    else await invoke("status");
    const text = surface === "picker" ? description() : notice.mock.calls[0]![1];
    expect(text).toContain("RTK savings unavailable");
    expect(text).not.toContain("no savings recorded");
    expect(text).not.toContain("no global RTK history");
    if (surface === "picker") {
      expect(picker().request.options.find((option) => option.value === "refresh")?.tone).toBe("warn");
    } else {
      expect(notice.mock.calls[0]![0]).toBe("warn");
    }
  });

  it.each(["picker", "status"])("distinguishes a valid empty session history in %s", async (surface) => {
    vi.mocked(readRtkGain).mockResolvedValue({ commands: 0, savedTokens: 0, savingsPct: 0 });
    const notice = vi.spyOn(services.session, "notice");
    if (surface === "picker") await open();
    else await invoke("status");
    const text = surface === "picker" ? description() : notice.mock.calls[0]![1];
    expect(text).toContain("no RTK savings recorded for this session yet");
    expect(text).not.toContain("unavailable");
  });

  it("does not describe a zero-saving execution as compressed output", async () => {
    vi.mocked(readRtkGain).mockResolvedValue({ commands: 1, savedTokens: 0, savingsPct: 0 });
    createRtkExecutionRecorder(services.session.sessionId)();
    await open();
    expect(description()).toContain("1 automatic RTK run this session");
    expect(description()).toContain("0 estimated tokens saved this session (0%)");
  });

  it("shows the current conversation's count after minting a new session", async () => {
    createRtkExecutionRecorder(services.session.sessionId)();
    await open();
    expect(description()).toContain("1 automatic RTK run this session");
    services.overlay.close();
    services.session.reset({ mintNewId: true });
    await open();
    expect(description()).toContain("0 automatic RTK runs this session");
  });

  it("keeps missing RTK separate from unavailable statistics", async () => {
    vi.mocked(detectRtk).mockResolvedValue({ state: "missing" });
    await open();
    expect(picker().request.title).toBe("RTK · on · inactive");
    expect(picker().request.options.find((option) => option.value === "refresh")?.label).toBe("rtk not installed");
    expect(readRtkGain).not.toHaveBeenCalled();
  });
});

describe("/rtk refresh ownership", () => {
  it("keeps the latest response when an older request completes afterward", async () => {
    const old = deferred<RtkGain | undefined>();
    const latest = deferred<RtkGain | undefined>();
    vi.mocked(readRtkGain).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    await open();
    const selection = picker().onSelect;
    services.overlay.selectPicker("refresh");
    await settle();
    expect(picker().request.options.find((option) => option.value === "refresh")?.label).toBe("Detecting rtk…");
    latest.resolve({ commands: 2, savedTokens: 200, savingsPct: 50 });
    await settle();
    expect(description()).toContain("200 estimated tokens saved this session");
    old.resolve({ commands: 1, savedTokens: 100, savingsPct: 25 });
    await settle();
    expect(description()).toContain("200 estimated tokens saved this session");
    expect(picker().onSelect).toBe(selection);
    expect(services.focus.activeContext()).toBe("picker");
  });

  it("does not replace the pending state with an older response", async () => {
    const old = deferred<RtkGain | undefined>();
    const latest = deferred<RtkGain | undefined>();
    vi.mocked(readRtkGain).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    await open();
    services.overlay.selectPicker("refresh");
    await settle();
    old.resolve({ commands: 1, savedTokens: 100, savingsPct: 25 });
    await settle();
    expect(picker().request.options.find((option) => option.value === "refresh")?.label).toBe("Detecting rtk…");
    latest.resolve(gain);
    await settle();
    expect(description()).toContain("1.5M estimated tokens saved this session");
  });

  it("does not reopen a closed picker", async () => {
    const response = deferred<RtkGain | undefined>();
    vi.mocked(readRtkGain).mockReturnValueOnce(response.promise);
    await open();
    services.overlay.close();
    response.resolve(gain);
    await settle();
    expect(services.overlay.getState().kind).toBe("none");
    expect(services.focus.activeContext()).toBe("composer");
  });

  it("does not overwrite a replacement picker", async () => {
    const response = deferred<RtkGain | undefined>();
    vi.mocked(readRtkGain).mockReturnValueOnce(response.promise);
    await open();
    services.overlay.close();
    services.overlay.openPicker({ title: "Other", options: [{ value: "other", label: "Other" }] }, () => undefined);
    response.resolve(gain);
    await settle();
    expect(picker().request.title).toBe("Other");
    expect(picker().request.options.map((option) => option.value)).toEqual(["other"]);
  });

  it("does not overwrite a newly opened RTK picker", async () => {
    const old = deferred<RtkGain | undefined>();
    vi.mocked(readRtkGain).mockReturnValueOnce(old.promise);
    await open();
    services.overlay.close();
    await open();
    old.resolve({ commands: 1, savedTokens: 100, savingsPct: 25 });
    await settle();
    expect(description()).toContain("1.5M estimated tokens saved this session");
  });

  it("ignores refresh results after the owning conversation changes", async () => {
    const response = deferred<RtkGain | undefined>();
    vi.mocked(readRtkGain).mockReturnValueOnce(response.promise);
    await open();
    const prior = services.overlay.getState();
    services.session.reset({ mintNewId: true });
    response.resolve(gain);
    await settle();
    expect(services.overlay.getState()).toBe(prior);
  });

  it("does not emit an old status into a new conversation", async () => {
    const response = deferred<RtkGain | undefined>();
    vi.mocked(readRtkGain).mockReturnValueOnce(response.promise);
    const notice = vi.spyOn(services.session, "notice");
    const reporting = invoke("status");
    await settle();
    services.session.reset({ mintNewId: true });
    response.resolve(gain);
    await reporting;
    expect(notice).not.toHaveBeenCalled();
  });
});
