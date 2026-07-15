import { describe, expect, it } from "vitest";
import { createPagerExportPort, type RendererSuspendPort } from "../../../src/tui-v2/bootstrap/pager-export.js";

function fakeRenderer(): RendererSuspendPort & { suspended: number; resumed: number } {
  return {
    suspended: 0,
    resumed: 0,
    suspend() {
      this.suspended += 1;
    },
    resume() {
      this.resumed += 1;
    },
  };
}

describe("pager export (PICK-003, V2-074)", () => {
  it("suspends and resumes the renderer around a scrollback export", () => {
    const renderer = fakeRenderer();
    const port = createPagerExportPort(renderer);
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      const result = port.exportToScrollback("Output", "line one\nline two");
      expect(result).toEqual({ ok: true });
      expect(renderer.suspended).toBe(1);
      expect(renderer.resumed).toBe(1);
      const dumped = writes.join("");
      // Leaves alt-screen and dumps a labeled block for terminal scrollback.
      expect(dumped).toContain("\x1b[?1049l");
      expect(dumped).toContain("clai export: Output");
      expect(dumped).toContain("line one\nline two");
      expect(dumped).toContain("end export");
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("always resumes even if suspend throws", () => {
    let resumed = false;
    const renderer: RendererSuspendPort = {
      suspend() {
        throw new Error("suspend failed");
      },
      resume() {
        resumed = true;
      },
    };
    const result = createPagerExportPort(renderer).exportToScrollback("t", "b");
    expect(result.ok).toBe(false);
    expect(resumed).toBe(true);
  });

  it("spawns $EDITOR over a temp file and resumes afterward", async () => {
    const original = process.env.EDITOR;
    process.env.EDITOR = process.platform === "win32" ? "cmd" : "true";
    try {
      const renderer = fakeRenderer();
      const result = await createPagerExportPort(renderer).exportToEditor("some content");
      expect(result.ok).toBe(true);
      expect(renderer.suspended).toBe(1);
      expect(renderer.resumed).toBe(1);
    } finally {
      if (original === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = original;
    }
  });

  it("reports failure and still resumes when the editor cannot be spawned", async () => {
    const original = process.env.EDITOR;
    process.env.EDITOR = "clai-test-nonexistent-editor-xyz";
    try {
      const renderer = fakeRenderer();
      const result = await createPagerExportPort(renderer).exportToEditor("content");
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(renderer.resumed).toBe(1);
    } finally {
      if (original === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = original;
    }
  });
});
