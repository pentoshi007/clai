import { describe, expect, it } from "vitest";
import { OutputSpool } from "../../src/app/events/event-buffer.js";
import { asToolCallId } from "../../src/app/events/app-event.js";

describe("artifact-backed output retention", () => {
  it("bounds resident output without losing access or byte counts", () => {
    const spool = new OutputSpool(128, 256);
    for (let index = 0; index < 100; index += 1) {
      const id = asToolCallId(`tool-${index}`);
      const text = `output-${index}:` + "x".repeat(300);
      spool.replace(id, text);
      spool.retainArtifact(id, () => text);
    }
    expect(spool.residentChars).toBeLessThanOrEqual(256);
    for (let index = 0; index < 100; index += 1) {
      const id = asToolCallId(`tool-${index}`);
      expect(spool.has(id)).toBe(true);
      expect(spool.tail(id)).toBe("x".repeat(128));
      expect(spool.state(id)).toMatchObject({ totalBytes: 300 + `output-${index}:`.length, truncated: true });
      expect(spool.residentChars).toBeLessThanOrEqual(256);
    }
  });

  it("retains outputs without an artifact and invalidates changed artifact content", () => {
    const spool = new OutputSpool(128, 128);
    const id = asToolCallId("live");
    const saved = asToolCallId("saved");
    spool.replace(id, "live content");
    spool.replace(saved, "x".repeat(128));
    spool.retainArtifact(saved, () => "x".repeat(128));
    expect(spool.tail(id)).toBe("live content");
    const before = spool.version(saved);
    spool.replace(saved, "new output");
    expect(spool.version(saved)).toBeGreaterThan(before);
    expect(spool.tail(saved)).toBe("new output");
    spool.clear();
    expect(spool.residentChars).toBe(0);
    expect(spool.has(saved)).toBe(false);
  });

  it("preserves original accounting when reloading a shorter artifact tail", () => {
    const spool = new OutputSpool(128, 128);
    const old = asToolCallId("old");
    spool.replace(old, "x".repeat(1000));
    spool.retainArtifact(old, () => "x".repeat(128));
    spool.replace(asToolCallId("current"), "y".repeat(128));
    const version = spool.version(old);
    expect(spool.state(old)).toMatchObject({ totalBytes: 1000, droppedBytes: 872, truncated: true });
    expect(spool.version(old)).toBe(version);
  });
});
