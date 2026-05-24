import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearViewports,
  getLastViewport,
  getViewport,
  listViewports,
  registerViewport,
  toggleViewport,
  formatViewportHint,
} from "../src/ui/output-pane.js";
import { isCtrlC, isCtrlO, isCtrlT, isEscape } from "../src/ui/keys.js";

describe("phase 6 — keys", () => {
  it("isCtrlO recognizes the canonical readline shape across platforms", () => {
    expect(isCtrlO({ ctrl: true, name: "o" })).toBe(true);
    expect(isCtrlO({ ctrl: false, name: "o" })).toBe(false);
    expect(isCtrlO({ ctrl: true, name: "p" })).toBe(false);
    // Many terminals also send the literal control byte as `sequence`.
    // We rely on readline's normalized `{ ctrl, name }`, not raw sequences,
    // so the same handler fires on macOS, Linux, and Windows.
  });
  it("isCtrlT / isCtrlC / isEscape are independent shapes", () => {
    expect(isCtrlT({ ctrl: true, name: "t" })).toBe(true);
    expect(isCtrlC({ ctrl: true, name: "c" })).toBe(true);
    expect(isEscape({ name: "escape" })).toBe(true);
  });
});

describe("phase 6 — output pane", () => {
  afterEach(() => clearViewports());

  it("registerViewport returns a unique id and remembers the last one", () => {
    const a = registerViewport({ toolName: "shell.exec", argsDisplay: "ls", summary: "sa" });
    const b = registerViewport({ toolName: "fs.read", argsDisplay: "x.txt", summary: "sb" });
    expect(a.id).not.toBe(b.id);
    expect(getLastViewport()?.id).toBe(b.id);
    expect(getViewport(a.id)?.summary).toBe("sa");
  });

  it("toggleViewport flips expanded and renders artifact + summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-pane-"));
    const artifact = join(dir, "raw.txt");
    writeFileSync(artifact, "RAW BIG OUTPUT\n");
    const v = registerViewport({
      toolName: "shell.exec",
      argsDisplay: "echo big",
      artifactPath: artifact,
      summary: "REDUCED",
    });
    const chunks: string[] = [];
    await toggleViewport(v.id, (c) => chunks.push(c));
    const expanded = chunks.join("");
    expect(getViewport(v.id)?.expanded).toBe(true);
    expect(expanded).toMatch(/RAW BIG OUTPUT/);
    expect(expanded).toMatch(/REDUCED/);
    chunks.length = 0;
    await toggleViewport(v.id, (c) => chunks.push(c));
    expect(getViewport(v.id)?.expanded).toBe(false);
    expect(chunks.join("")).toMatch(/collapsed/);
  });

  it("toggleViewport without an artifact still toggles", async () => {
    const v = registerViewport({ toolName: "sysinfo", argsDisplay: "", summary: "SUM" });
    const chunks: string[] = [];
    await toggleViewport(v.id, (c) => chunks.push(c));
    expect(chunks.join("")).toMatch(/no artifact file/);
  });

  it("formatViewportHint mentions /output last as a non-TTY fallback", () => {
    const v = registerViewport({
      toolName: "shell.exec",
      argsDisplay: "ls",
      summary: "S",
      artifactPath: "/tmp/x.txt",
    });
    expect(formatViewportHint(v)).toMatch(/\/output last/);
  });

  it("listViewports returns viewports in creation order", () => {
    const a = registerViewport({ toolName: "a", argsDisplay: "", summary: "" });
    const b = registerViewport({ toolName: "b", argsDisplay: "", summary: "" });
    expect(listViewports().map((v) => v.id)).toEqual([a.id, b.id]);
  });
});
