import { describe, expect, it, afterEach } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { fsWriteMany } from "../src/tools/fs.js";
import { classifyToolCall } from "../src/safety/classifier.js";
import { toolRegistry, availableToolNames } from "../src/tools/registry.js";

// cwd-relative temp dirs pass the write sandbox check (cwd + children).
function makeTempDir(prefix: string): string {
  return mkdtempSync(join(process.cwd(), `.test-tmp-${prefix}-`));
}

describe("fsWriteMany", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it("is registered and classified as confirm", () => {
    expect(toolRegistry["fs.writeMany"]).toBeDefined();
    expect(availableToolNames()).toContain("fs.writeMany");
    const decision = classifyToolCall({
      name: "fs.writeMany",
      args: { files: [{ path: "a.txt", content: "x" }] },
    });
    expect(decision.level).toBe("confirm");
  });

  it("writes multiple files in one call and creates parent dirs", async () => {
    const dir = makeTempDir("wm");
    dirs.push(dir);
    const result = await fsWriteMany([
      { path: join(dir, "package.json"), content: "{}" },
      { path: join(dir, "src/index.js"), content: "console.log(1);" },
      { path: join(dir, "src/App.jsx"), content: "export default 1;" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Wrote 3 file(s)");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe("{}");
    expect(existsSync(join(dir, "src/index.js"))).toBe(true);
    expect(existsSync(join(dir, "src/App.jsx"))).toBe(true);
  });

  it("reports failures per-file without aborting the whole batch", async () => {
    const dir = makeTempDir("wm");
    dirs.push(dir);
    const result = await fsWriteMany([
      { path: join(dir, "ok.txt"), content: "ok" },
      // Outside the sandbox -> ensureWriteAllowed throws, captured as failure.
      { path: "/etc/definitely-not-allowed.txt", content: "nope" },
    ]);
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, "ok.txt"))).toBe(true);
    expect(result.output).toContain("Wrote 1 file(s)");
    expect(result.output).toContain("Failed 1 file(s)");
  });

  it("rejects an empty files array", async () => {
    const result = await fsWriteMany([]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("non-empty");
  });

  it("blocks the batch if any target is a secret path", () => {
    const decision = classifyToolCall({
      name: "fs.writeMany",
      args: {
        files: [
          { path: "ok.txt", content: "x" },
          { path: "~/.ssh/id_rsa", content: "evil" },
        ],
      },
    });
    expect(decision.level).toBe("block");
  });
});
