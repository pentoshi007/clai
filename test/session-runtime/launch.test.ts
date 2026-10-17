import { afterEach, describe, expect, it, vi } from "vitest";
import { selfLaunchSpec } from "../../src/session-runtime/launch.js";

afterEach(() => vi.unstubAllGlobals());

describe("standalone runtime launches", () => {
  it.each(["/$bunfs/root/src/index.ts", "B:\\~BUN\\root\\src\\index.ts", "B:/~BUN/root/src/index.ts", "bun:main"])("does not pass the embedded entry as a prompt: %s", (entry) => {
    vi.stubGlobal("Bun", {});
    expect(selfLaunchSpec(entry, ["--classic"])).toEqual({ file: process.execPath, args: ["--classic"] });
  });

  it("keeps external Bun entry paths", () => {
    vi.stubGlobal("Bun", {});
    expect(selfLaunchSpec("C:\\clai\\dist\\index.js", ["--classic"]).args).toEqual(["C:\\clai\\dist\\index.js", "--classic"]);
  });
});
