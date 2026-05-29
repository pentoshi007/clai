import { describe, expect, it } from "vitest";
import { pdfRead } from "../src/tools/pdf.js";

describe("pdf.read — argument validation", () => {
  it("requires a path", async () => {
    const result = await pdfRead({});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("pdf.read expects");
  });

  it("rejects an invalid lang", async () => {
    const result = await pdfRead({ path: "/tmp/x.pdf", lang: "en;rm -rf" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("lang may contain");
  });

  it("rejects an out-of-range dpi", async () => {
    const low = await pdfRead({ path: "/tmp/x.pdf", dpi: 10 });
    expect(low.ok).toBe(false);
    expect(low.output).toContain("dpi must be");
    const high = await pdfRead({ path: "/tmp/x.pdf", dpi: 1200 });
    expect(high.ok).toBe(false);
    expect(high.output).toContain("dpi must be");
  });

  it("reports a clear error when the file does not exist", async () => {
    const result = await pdfRead({
      path: "/tmp/clai-does-not-exist-1234567890.pdf",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/cannot read|not a regular file/);
  });
});
