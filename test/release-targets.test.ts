import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nativePackages, parseReleaseTarget, releaseTargets, targetBuildArguments, targetNativePackages } from "../scripts/release-targets.js";

describe("target-specific release bundles", () => {
  it.each(releaseTargets)("keeps only the native library %s can load", (target) => {
    const keep = targetNativePackages(target);
    const args = targetBuildArguments(target, "/output");
    for (const name of nativePackages) expect(args.includes(name)).toBe(!keep.includes(name));
    expect(args).toContain("--minify");
    expect(args).toContain("--splitting");
    expect(args).toContain(target);
    if (target.includes("linux")) {
      expect(keep).toEqual([`@opentui/core-linux-${target.split("-")[2]}`]);
      expect(args).toContain(`@opentui/core-linux-${target.split("-")[2]}-musl`);
    }
    if (target.includes("darwin")) expect(keep).toHaveLength(1);
    if (target.includes("windows")) {
      expect(keep).toHaveLength(0);
      expect(args).toContain("@opentui/core");
      expect(args).toContain("@opentui/react");
      expect(args).toContain('process.platform="win32"');
    }
  });

  it("does not force React production builds, which stall the compiled OpenTUI renderer", () => {
    for (const target of releaseTargets) {
      expect(targetBuildArguments(target, "/output").some((arg) => arg.includes("NODE_ENV"))).toBe(false);
    }
  });

  it("rejects unsupported target input", () => {
    expect(() => parseReleaseTarget("bun-linux-something")).toThrow(/Unsupported/);
  });

  it("uses the same target configuration in local builds and CI", () => {
    const build = readFileSync("scripts/build.ts", "utf8");
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(build).toContain("targetBuildArguments");
    expect(workflow).toContain("bun run scripts/build.ts --target ${{ matrix.target }}");
    expect(workflow).not.toContain("Install all @opentui/core");
  });
});
