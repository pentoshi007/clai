import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandInvocation } from "../src/app/commands/command.js";
import { getConfig, updateConfig } from "../src/store/config.js";
import { detectRtk } from "../src/tools/rtk/binary.js";
import type { AppServices } from "../src/ui-core/bootstrap/composition-root.js";
import { handleRtk } from "../src/ui-core/commands/rtk-commands.js";

vi.mock("../src/tools/rtk/binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/rtk/binary.js")>()),
  detectRtk: vi.fn(),
}));

const notice = vi.fn();
const services = { session: { notice } } as unknown as AppServices;

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
