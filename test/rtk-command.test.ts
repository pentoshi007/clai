import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandInvocation } from "../src/app/commands/command.js";
import { getConfig, updateConfig } from "../src/store/config.js";
import { detectRtk } from "../src/tools/rtk/binary.js";
import { runRtkMaintenance } from "../src/tools/rtk/install.js";
import type { AppServices } from "../src/ui-core/bootstrap/composition-root.js";
import { handleRtk } from "../src/ui-core/commands/rtk-commands.js";

vi.mock("../src/tools/rtk/binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/rtk/binary.js")>()),
  detectRtk: vi.fn(),
}));

vi.mock("../src/tools/rtk/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/rtk/install.js")>()),
  runRtkMaintenance: vi.fn(),
  rtkMaintenance: vi.fn(() => undefined),
  setRtkMaintenanceListener: vi.fn(),
}));

const notice = vi.fn();
const toast = { info: vi.fn(() => 0), dismiss: vi.fn() };
const services = { session: { notice }, toast } as unknown as AppServices;

const invoke = (args: string): Promise<void> | void =>
  handleRtk(services, { name: "rtk", args } as CommandInvocation);

describe("/rtk on and off", () => {
  beforeEach(() => {
    notice.mockReset();
    vi.mocked(detectRtk).mockReset();
    updateConfig({ rtk: false });
  });

  it("verifies rtk with a fresh probe instead of trusting a cached result", async () => {
    vi.mocked(detectRtk).mockResolvedValue({ state: "ready", path: "/opt/bin/rtk", version: "0.50.0" });
    await invoke("on");
    expect(detectRtk).toHaveBeenCalledWith(true);
    expect(getConfig().rtk).toBe(true);
    expect(notice).toHaveBeenCalledWith("info", expect.stringContaining("rtk 0.50.0"));
  });

  it("enables compression but warns that it is inactive while rtk is missing", async () => {
    vi.mocked(detectRtk).mockResolvedValue({ state: "missing" });
    await invoke("on");
    expect(getConfig().rtk).toBe(true);
    expect(notice).toHaveBeenCalledWith("warn", expect.stringContaining("inactive"));
  });

  it("turns compression off without probing for rtk", async () => {
    updateConfig({ rtk: true });
    await invoke("off");
    expect(getConfig().rtk).toBe(false);
    expect(detectRtk).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith("info", expect.stringContaining("RTK off"));
  });
});

describe("/rtk maintenance messages", () => {
  beforeEach(() => {
    notice.mockReset();
    vi.mocked(runRtkMaintenance).mockReset();
  });

  it("reports an already-current rtk instead of surfacing winget's no-applicable-update code", async () => {
    const ready = { state: "ready" as const, path: "/opt/bin/rtk", version: "0.24" };
    vi.mocked(runRtkMaintenance).mockResolvedValue({
      ok: true,
      action: "update",
      status: ready,
      installer: "winget",
      previousVersion: "0.24",
    });
    await invoke("update");
    await vi.waitFor(() => expect(notice).toHaveBeenCalled());
    expect(notice).toHaveBeenLastCalledWith("info", expect.stringContaining("already the latest (winget)"));
    expect(notice.mock.calls.at(-1)?.[1]).not.toContain("2316632107");
  });

  it("keeps a genuine winget failure actionable and free of raw exit codes", async () => {
    vi.mocked(runRtkMaintenance).mockResolvedValue({
      ok: false,
      action: "update",
      reason: "winget: no applicable update found (latest published is 0.24.0); cargo: cargo is not installed",
      status: { state: "missing" },
      manual: "install rtk manually (rtk-ai/rtk ≥ 0.23):",
    });
    await invoke("update");
    await vi.waitFor(() => expect(notice).toHaveBeenCalled());
    expect(notice).toHaveBeenLastCalledWith("warn", expect.stringContaining("no applicable update found"));
    expect(notice.mock.calls.at(-1)?.[1]).toContain("install rtk manually");
    expect(notice.mock.calls.at(-1)?.[1]).not.toContain("2316632107");
  });
});
