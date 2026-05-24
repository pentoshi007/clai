import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("phase 11 — install scripts verify SHA256", () => {
  const sh = readFileSync(
    resolve(__dirname, "../install/install.sh"),
    "utf8",
  );
  const ps1 = readFileSync(
    resolve(__dirname, "../install/install.ps1"),
    "utf8",
  );

  it("install.sh fetches a .sha256 sidecar and aborts on mismatch", () => {
    expect(sh).toMatch(/\.sha256/);
    expect(sh).toMatch(/Checksum mismatch/);
    expect(sh).toMatch(/CLAI_SKIP_CHECKSUM/);
    // sha256sum or shasum -a 256 must be invoked
    expect(sh).toMatch(/sha256sum|shasum -a 256/);
  });

  it("install.ps1 fetches a .sha256 sidecar and aborts on mismatch", () => {
    expect(ps1).toMatch(/\.sha256/);
    expect(ps1).toMatch(/Checksum mismatch/);
    expect(ps1).toMatch(/CLAI_SKIP_CHECKSUM/);
    expect(ps1).toMatch(/Get-FileHash/);
  });
});

describe("phase 11 — release workflow publishes .sha256 sidecars", () => {
  const yaml = readFileSync(
    resolve(__dirname, "../.github/workflows/release.yml"),
    "utf8",
  );

  it("release workflow computes a SHA256 sidecar per binary", () => {
    expect(yaml).toMatch(/sha256sum/i);
    expect(yaml).toMatch(/\.sha256/);
  });
});

describe("phase 11 — manifests align with package version", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, "../package.json"), "utf8"),
  ) as { version: string };

  it("Homebrew formula lists the package version", () => {
    const rb = readFileSync(
      resolve(__dirname, "../manifests/homebrew/clai.rb"),
      "utf8",
    );
    expect(rb).toContain(`version "${pkg.version}"`);
  });

  it("Scoop manifest lists the package version", () => {
    const json = JSON.parse(
      readFileSync(resolve(__dirname, "../manifests/scoop/clai.json"), "utf8"),
    ) as { version: string };
    expect(json.version).toBe(pkg.version);
  });
});
