import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDefaultCommandRegistry } from "../../src/app/commands/registry.js";
import { handleRea } from "../../src/ui-core/commands/rea-commands.js";
import { composerActionPort } from "../../src/ui-core/composer/composer-action-port.js";
import { manageRea } from "../../src/rea/runtime.js";
import { detectRea } from "../../src/rea/install.js";
import { findReaMentions } from "../../src/rea/workflow.js";
import { composerMentionSpans } from "../../src/classic/chrome/composer-mentions.js";
import type { AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import type { PickerOption } from "../../src/ui-core/rendering/picker-filter.js";

vi.mock("../../src/rea/runtime.js", () => ({ manageRea: vi.fn() }));
vi.mock("../../src/rea/install.js", () => ({ detectRea: vi.fn(), reaMaintenance: vi.fn(), reaRoot: () => "/managed/rea", subscribeReaProgress: () => () => undefined }));

const notice = vi.fn();
let controller = new AbortController();
const interruptible = { begin: vi.fn(() => controller), end: vi.fn() };
const submit = vi.fn();
const enqueue = vi.fn();
let selection: ((value: string) => void) | undefined;
let pickerOptions: PickerOption[];
let open = false;
let running = false;
const services = {
  session: { sessionId: "rea-command", notice, submit, enqueue, getState: () => ({ running }) },
  mcp: { getState: () => ({ snapshot: { statuses: [] }, selection: { mode: "off" } }) },
  toast: { info: vi.fn(() => 1), dismiss: vi.fn() },
  interruptible,
  focus: { focusRegion: vi.fn() },
  overlay: {
    openPicker: (options: { options: PickerOption[] }, callback: (value: string) => void) => { pickerOptions = options.options; selection = callback; open = true; },
    replacePickerOptions: (options: PickerOption[]) => { pickerOptions = options; },
    getState: () => open ? { kind: "picker", onSelect: selection } : { kind: "none" },
    close: () => { open = false; },
    openPager: vi.fn(),
  },
} as unknown as AppServices;

const invoke = (args = "") => handleRea(services, { name: "rea", args, context: "composer" });
let unregister: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  open = false; running = false;
  controller = new AbortController();
  vi.mocked(detectRea).mockResolvedValue({ state: "missing" });
  vi.mocked(manageRea).mockResolvedValue({ ok: true, output: "done" });
});
afterEach(() => { unregister?.(); unregister = undefined; });

describe("/rea picker and composer", () => {
  it("registers /rea in the same command catalog used by both TUIs", () => {
    const registry = buildDefaultCommandRegistry();
    expect(registry.parse("/rea use")).toMatchObject({ name: "rea", args: "use" });
    expect(registry.suggestions("/rea").map((command) => command.name)).toContain("rea");
  });

  it("opens a responsive picker then offers bootstrap/setup without installed npm", async () => {
    await invoke();
    await vi.waitFor(() => expect(pickerOptions.some((option) => option.value === "setup")).toBe(true));
    expect(pickerOptions.find((option) => option.value === "setup")?.label).toContain("Install");
    expect(manageRea).not.toHaveBeenCalled();
  });

  it("offers update/use/reconnect for an installed REA", async () => {
    vi.mocked(detectRea).mockResolvedValue({ state: "ready", installation: { node: "/node", entry: "/rea", version: "6.7.0", directory: "/managed" } });
    await invoke();
    await vi.waitFor(() => expect(pickerOptions.map((option) => option.value)).toEqual(expect.arrayContaining(["use", "update", "reconnect"])));
  });

  it("inserts @rea as an editable composer token after activation", async () => {
    const inserted: string[] = [];
    unregister = composerActionPort.registerInsert((text) => { inserted.push(text); });
    await invoke("use");
    await vi.waitFor(() => expect(inserted).toEqual(["@rea "]));
    expect(manageRea).toHaveBeenCalledWith(services.mcp, "enable", {});
  });

  it("submits a /rea task as an @rea prompt rather than swallowing it as an invalid command", async () => {
    await invoke("inspect the supplied Electron app");
    expect(submit).toHaveBeenCalledWith("@rea inspect the supplied Electron app");
    running = true;
    await invoke("inspect the supplied binary");
    expect(enqueue).toHaveBeenCalledWith("@rea inspect the supplied binary");
  });

  it("paints @rea but not paths, e-mail addresses, URLs or the command", () => {
    expect(findReaMentions("read @rea/README.md, me@rea.com, https://example.test/@rea and /rea")).toEqual([]);
    const text = "inspect @rea this binary";
    const ranges = composerMentionSpans(text, new Set(), new Set());
    expect(ranges).toEqual([{ start: 8, end: 12, color: "aqua" }]);
  });

  it("reports activation errors without inserting a misleading token", async () => {
    const insert = vi.fn();
    unregister = composerActionPort.registerInsert(insert);
    vi.mocked(manageRea).mockResolvedValue({ ok: false, output: "REA missing" });
    await invoke("use");
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith("warn", "REA missing"));
    expect(insert).not.toHaveBeenCalled();
  });

  it("opens the usage guide as a markdown pager without starting or installing anything", async () => {
    vi.mocked(detectRea).mockResolvedValue({ state: "ready", installation: { node: "/node", entry: "/rea", version: "6.7.0", directory: "/managed" } });
    await invoke("guide");
    expect(services.overlay.openPager).toHaveBeenCalledWith(
      "REA · Reverse Engineer Anything",
      expect.stringContaining("REA 6.7.0 installed"),
      undefined,
      undefined,
      "force",
    );
    const body = vi.mocked(services.overlay.openPager).mock.calls[0]![1];
    expect(body).toContain("## Troubleshooting");
    expect(manageRea).not.toHaveBeenCalled();
  });

  it("opens the same guide from the picker entry", async () => {
    await invoke();
    await vi.waitFor(() => expect(pickerOptions.some((option) => option.value === "guide")).toBe(true));
    selection!("guide");
    await vi.waitFor(() => expect(services.overlay.openPager).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("not installed"), undefined, undefined, "force"));
  });

  it("makes installation cancellable and reports the cancellation instead of a failure", async () => {
    vi.mocked(manageRea).mockImplementation(async (_runtime, _action, options) => {
      controller.abort();
      return { ok: false, output: `REA install failed: ${String(options?.signal?.aborted)}` };
    });
    await invoke("install");
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith("info", "REA install cancelled · nothing was changed"));
    expect(manageRea).toHaveBeenCalledWith(services.mcp, "install", { signal: controller.signal });
    expect(interruptible.end).toHaveBeenCalledWith(controller);
    expect(notice).not.toHaveBeenCalledWith("warn", expect.anything());
  });

  it("connects after setup installs using the same cancellation signal", async () => {
    await invoke("setup");
    await vi.waitFor(() => expect(manageRea).toHaveBeenCalledTimes(2));
    expect(manageRea).toHaveBeenNthCalledWith(1, services.mcp, "install", { signal: controller.signal });
    expect(manageRea).toHaveBeenNthCalledWith(2, services.mcp, "enable", { signal: controller.signal });
    expect(interruptible.begin).toHaveBeenCalledOnce();
    expect(interruptible.end).toHaveBeenCalledOnce();
  });

  it("does not treat quick actions as interruptible work", async () => {
    await invoke("off");
    await vi.waitFor(() => expect(manageRea).toHaveBeenCalledWith(services.mcp, "disable", {}));
    expect(interruptible.begin).not.toHaveBeenCalled();
    expect(vi.mocked(services.toast.info).mock.calls[0]![0]).toBe("Stopping REA…");
  });

  it("does not reset a running analysis through a picker command", async () => {
    running = true;
    await invoke("reconnect");
    expect(manageRea).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith("warn", expect.stringContaining("running turn"));
  });
});
