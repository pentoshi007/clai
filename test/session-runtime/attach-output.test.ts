import { describe, expect, it } from "vitest";
import { TerminalAttachOutput } from "../../src/session-runtime/attach-output.js";

function fixture(limit?: number) {
  const writes: string[] = [];
  const output = new TerminalAttachOutput(
    Buffer.from("old frame"),
    (bytes) => writes.push(Buffer.from(bytes).toString()),
    limit,
  );
  return { output, writes };
}

describe("terminal attach output ordering", () => {
  it("holds live output until the repaint decision and omits stale replay on acceptance", () => {
    const { output, writes } = fixture();
    output.push(Buffer.from("delta"));
    output.push(Buffer.from("full frame"));
    expect(writes).toEqual([]);
    output.finish(true);
    output.push(Buffer.from("next frame"));
    expect(writes).toEqual(["delta", "full frame", "next frame"]);
  });

  it("orders fallback replay ahead of every live byte on decline or timeout", () => {
    const { output, writes } = fixture();
    output.push(Buffer.from("new frame"));
    output.finish(false);
    output.push(Buffer.from("newer frame"));
    output.finish(false);
    expect(writes).toEqual(["old frame", "new frame", "newer frame"]);
  });

  it("bounds the pending buffer without dropping bytes or blocking child output", () => {
    const { output, writes } = fixture(8);
    output.push(Buffer.from("12345678"));
    expect(writes).toEqual([]);
    output.push(Buffer.from("9"));
    output.finish(true);
    output.push(Buffer.from("10"));
    expect(writes).toEqual(["old frame", "12345678", "9", "10"]);
  });

  it("sends an oversized chunk directly after ordered fallback instead of retaining it", () => {
    const { output, writes } = fixture(1);
    output.push(Buffer.from("burst"));
    output.finish(false);
    expect(writes).toEqual(["old frame", "burst"]);
  });

  it("drops a disconnected attachment without writing after a late repaint reply", () => {
    const { output, writes } = fixture();
    output.push(Buffer.from("pending"));
    output.dispose();
    output.finish(false);
    output.push(Buffer.from("late"));
    expect(writes).toEqual([]);
  });

  it("owns pending transport bytes even when the transport reuses its buffer", () => {
    const { output, writes } = fixture();
    const bytes = Buffer.from("frame");
    output.push(bytes);
    bytes.fill(0);
    output.finish(true);
    expect(writes).toEqual(["frame"]);
  });

  it("rejects an invalid retention limit", () => {
    expect(() => fixture(0)).toThrow("positive integer");
    expect(() => fixture(Infinity)).toThrow("positive integer");
  });
});
