import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeInputStream } from "../../src/session-runtime/input-stream.js";

afterEach(() => vi.useRealTimers());

function stream() {
  const inputs: Buffer[] = [];
  const replies: Buffer[] = [];
  const parser = new RuntimeInputStream((bytes, reply) => (reply ? replies : inputs).push(bytes));
  return { parser, inputs, replies };
}

describe("runtime input stream", () => {
  it("separates fragmented terminal replies from user input without changing bytes", () => {
    const { parser, inputs, replies } = stream();
    parser.push(Buffer.from("hello\x1b[?1;"));
    parser.push(Buffer.from("2c\x1b[12;40Rworld\x1b]11;rgb:ffff/ffff/ffff\x1b"));
    parser.push(Buffer.from("\\\r"));
    expect(Buffer.concat(inputs).toString()).toBe("helloworld\r");
    expect(Buffer.concat(replies).toString()).toBe("\x1b[?1;2c\x1b[12;40R\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
    parser.dispose();
  });

  it("retains complete large pastes including reply-shaped text and fragmented UTF-8", () => {
    const { parser, inputs, replies } = stream();
    const paste = Buffer.from(`\x1b[200~${"é😀\x1b[?1;2c\n".repeat(20_000)}\x1b[201~`);
    for (let offset = 0; offset < paste.length; offset += 101) parser.push(paste.subarray(offset, offset + 101));
    expect(Buffer.concat(inputs)).toEqual(paste);
    expect(replies).toHaveLength(0);
    parser.dispose();
  });

  it("streams a large clipboard reply separately from subsequent typed input", () => {
    const { parser, inputs, replies } = stream();
    const reply = Buffer.from(`\x1b]52;c;${"x".repeat(200_000)}\x1b\\`);
    for (let offset = 0; offset < reply.length; offset += 4096) parser.push(reply.subarray(offset, offset + 4096));
    parser.push(Buffer.from("prompt\r"));
    expect(Buffer.concat(replies)).toEqual(reply);
    expect(Buffer.concat(inputs).toString()).toBe("prompt\r");
    parser.dispose();
  });

  it("keeps shortcuts, mouse events, modified F3, and unknown sequences intact", () => {
    const { parser, inputs, replies } = stream();
    const keys = "\x03\x1b[99;5u\x1b[<64;12;9M\x1b[1;2R\x1bOP\x1b[999~";
    for (const byte of Buffer.from(keys)) parser.push(Buffer.from([byte]));
    expect(Buffer.concat(inputs).toString()).toBe(keys);
    expect(replies).toHaveLength(0);
    parser.dispose();
  });

  it("recognizes a cursor reply after a fragmented query without counting it twice", () => {
    const { parser, inputs, replies } = stream();
    parser.observeOutput(Buffer.from("\x1b["));
    parser.observeOutput(Buffer.from("6n"));
    parser.observeOutput(Buffer.from("text"));
    parser.push(Buffer.from("\x1b[1;2R\x1b[1;2R"));
    expect(replies.map(String)).toEqual(["\x1b[1;2R"]);
    expect(Buffer.concat(inputs).toString()).toBe("\x1b[1;2R");
    parser.dispose();
  });

  it("forwards a lone escape after its timeout and cancels pending work on disposal", async () => {
    vi.useFakeTimers();
    const { parser, inputs } = stream();
    parser.push(Buffer.from("\x1b"));
    await vi.advanceTimersByTimeAsync(50);
    expect(inputs.map(String)).toEqual(["\x1b"]);
    parser.push(Buffer.from("\x1b["));
    parser.dispose();
    await vi.advanceTimersByTimeAsync(50);
    expect(inputs.map(String)).toEqual(["\x1b"]);
  });
});
