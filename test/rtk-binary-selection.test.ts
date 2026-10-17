import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeRtk, type FakeRtk } from "./helpers/fake-rtk.js";
import { detectRtk, forgetRtk } from "../src/tools/rtk/binary.js";

const fixtures: FakeRtk[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose();
  forgetRtk();
});

describe.skipIf(process.platform === "win32")("RTK fallback binary selection", () => {
  it("prefers a newer verified install over an outdated executable earlier on PATH", async () => {
    const old = await installFakeRtk();
    fixtures.push(old);
    const installed = await installFakeRtk({ onPath: false });
    fixtures.push(installed);
    await writeFile(installed.path, (await readFile(installed.path, "utf8")).replace("rtk 0.50.0", "rtk 999.0.0"));
    vi.stubEnv("RTK_INSTALL_DIR", installed.dir);
    const status = await detectRtk(true);
    expect(status).toMatchObject({ state: "ready", path: installed.path, version: "999.0.0" });
    if (status.state === "ready") expect(status.pathEntry?.position).toBe("prepend");
  });
});
