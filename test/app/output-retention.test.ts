import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BoundedText } from "../../src/app/events/event-buffer.js";
import { copyString } from "../../src/os/copy-string.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const probe = fileURLToPath(new URL("../fixtures/retained-output-probe.mjs", import.meta.url));

describe("retained output memory", () => {
  it.each(["spool", "guard", "evidence"])(
    "%s projections release the backing storage of large outputs",
    async (kind) => {
      const { stdout } = await run(
        process.execPath,
        ["--expose-gc", "--import", "tsx/esm", probe, kind],
        { cwd: root, timeout: 30_000 },
      );
      const report = JSON.parse(stdout) as { retainedBytes: number };
      expect(report.retainedBytes).toBeLessThan(24 * 1024 * 1024);
    },
    40_000,
  );

  it.each(["", "plain text", "αβ\u0000中文😀", "\ud800test\udfff"])(
    "copies every UTF-16 code unit unchanged: %j",
    (text) => {
      expect(copyString(text)).toBe(text);
    },
  );

  it("preserves existing tail, byte accounting, replacement, and unlimited behavior", () => {
    const text = "prefix".repeat(1_000) + "α😀\ud800";
    const buffer = new BoundedText(4);
    buffer.append(text);
    expect(buffer.snapshot()).toEqual({
      tail: text.slice(-4),
      totalBytes: Buffer.byteLength(text),
      droppedBytes: Buffer.byteLength(text.slice(0, -4)),
      truncated: true,
    });
    buffer.replace("all");
    expect(buffer.snapshot()).toEqual({
      tail: "all",
      totalBytes: 3,
      droppedBytes: 0,
      truncated: false,
    });
    const unlimited = new BoundedText(Number.POSITIVE_INFINITY);
    unlimited.append(text);
    unlimited.append(text);
    expect(unlimited.tail).toBe(text + text);
    expect(unlimited.droppedBytes).toBe(0);
  });
});
