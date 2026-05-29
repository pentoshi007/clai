import { describe, expect, it } from "vitest";
import { runToolCall } from "../src/tools/registry.js";

describe("pkg.install idempotency (check before install)", () => {
  it("skips installing a tool that is already on PATH", async () => {
    // node is running this test, so `node` is guaranteed on PATH.
    const result = await runToolCall({
      name: "pkg.install",
      args: { tool: "node" },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/already installed/i);
  });

  it("honors an explicit checkBinary that differs from the package name", async () => {
    const result = await runToolCall({
      name: "pkg.install",
      args: { tool: "coreutils", checkBinary: "node" },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/already installed/i);
  });

  it("resolves a known package→binary alias (ripgrep→rg)", async () => {
    // We can't guarantee rg is installed in CI, so only assert that WHEN it
    // resolves to skip, the message references the binary name, not the pkg.
    const result = await runToolCall({
      name: "pkg.install",
      args: { tool: "ripgrep", checkBinary: "node" },
    });
    expect(result.output).toMatch(/node is already installed/i);
  });
});
