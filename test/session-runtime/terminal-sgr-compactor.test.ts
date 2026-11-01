import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TerminalSgrCompactor } from "../../src/os/terminal-sgr-compactor.js";
import { applySgr, sgrDifference } from "../../src/os/sgr-state.js";

function compact(text: string, chunkSize = Buffer.byteLength(text)): string {
  const output = new TerminalSgrCompactor();
  const bytes = Buffer.from(text);
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < bytes.length; index += Math.max(1, chunkSize)) chunks.push(output.compact(bytes.subarray(index, index + chunkSize)));
  chunks.push(output.finish());
  return Buffer.concat(chunks).toString();
}

function painted(text: string): string[] {
  const state = new Map<number, string>();
  const result: string[] = [];
  const tokens = text.match(/\x1b\[[\d;]*m|[^\x1b]+/g) ?? [];
  for (const token of tokens) {
    if (!token.startsWith("\x1b")) {
      const style = JSON.stringify([...state].sort(([left], [right]) => left - right));
      for (const glyph of token) result.push(`${glyph}:${style}`);
      continue;
    }
    const codes = token.slice(2, -1).split(";").map(Number);
    while (codes.length > 0) {
      const code = codes.shift()!;
      if (code === 0) state.clear();
      else if (code === 38 || code === 48 || code === 58) {
        const mode = codes.shift()!;
        const channels = codes.splice(0, mode === 2 ? 3 : 1);
        state.set(code + 1, [code, mode, ...channels].join(";"));
      } else if (code === 22) { state.delete(1); state.delete(2); }
      else if (code === 23) state.delete(3);
      else if (code === 24) { state.delete(4); state.delete(21); }
      else if (code === 27) state.delete(7);
      else if (code === 28) state.delete(8);
      else if (code === 29) state.delete(9);
      else if (code === 39 || code === 49 || code === 59) state.delete(code);
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.set(39, String(code));
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.set(49, String(code));
      else state.set(code, String(code));
    }
  }
  return result;
}

describe("terminal output compaction", () => {
  it("reuses style across positioned runs instead of resetting and resending RGB colors", () => {
    const color = "\x1b[38;2;74;222;128m\x1b[48;2;11;14;20m";
    const source = `\x1b[0m${Array.from({ length: 40 }, (_, row) => `\x1b[${row + 1};3H${color}ROW_${row}\x1b[0m`).join("")}`;
    const result = compact(source);
    expect(Buffer.byteLength(result)).toBeLessThan(Buffer.byteLength(source) * 0.5);
    expect(result.replace(/\x1b\[[\d;]*m/g, "")).toBe(source.replace(/\x1b\[[\d;]*m/g, ""));
    expect(result.endsWith("\x1b[0m") || result.endsWith("\x1b[39;49m")).toBe(true);
  });

  it("preserves intensity resets, inverse, underline, ANSI colors, RGB and Unicode", () => {
    const source = "\x1b[0m\x1b[1;2;3;4;7;8;9m日本語 🧪\x1b[0m\x1b[1;2;3;4;7;8;9m again\x1b[22;23;24;27;28;29m plain\x1b[91;104m bright\x1b[38;5;123;48;2;1;2;3m color\x1b[39;49m end\x1b[0m";
    for (const size of [1, 2, 7, 31, Buffer.byteLength(source)]) expect(painted(compact(source, size))).toEqual(painted(source));
  });

  it("keeps links, clipboard, terminal queries, mode changes and opaque control strings intact", () => {
    const source = "\x1b[0m\x1b]8;;https://example.test/\x1b[0m\x07link\x1b]8;;\x1b\\\x1b]52;c;SGVsbG8=\x07\x1bPtmux;\x1b\x1b[0m\x1b\\\x1b_Gi=1;payload\x1b[0m\x1b\\\x1b[?2026h\x1b[2J\x1b[?2026l\x1b[6n\x1b[?1049l";
    for (let size = 1; size <= source.length; size += 1) expect(compact(source, size)).toBe(source);
  });

  it("keeps styles after opaque controls that may change the terminal state", () => {
    for (const control of ["\x1bPtmux;\x1b\x1b[32m\x1b\\", "\x1b]1337;opaque\x07", "\x1b_opaque\x1b\\"]) {
      const source = `\x1b[0m\x1b[31mbefore${control}\x1b[31mafter\x1b[0m`;
      for (const size of [1, 3, source.length]) expect(compact(source, size)).toBe(source);
    }
  });

  it("passes unsupported SGR and reset/restore sequences through conservatively", () => {
    const source = "\x1b[0m\x1b[4:3mcurly\x1b[4:3munderline\x1b[10mfont\x1b7\x1b[31mred\x1b8restore\x1bcreset\x1b[31mred\x1b[0m";
    expect(compact(source)).toBe(source);
  });

  it("does not buffer unbounded or unfinished control sequences", () => {
    const source = `\x1b[${"1;".repeat(800)}m日本語\x1b[0m\x1b[38;2;`;
    expect(compact(source, 80)).toBe(source);
    const string = `\x1b]52;c;${"x".repeat(20_000)}`;
    expect(compact(string, 20)).toBe(string);
  });

  it("preserves painted styles for arbitrary bursts and packet boundaries", () => {
    const code = fc.constantFrom("0", "1", "2", "3", "4", "7", "8", "9", "22", "23", "24", "27", "28", "29", "31", "44", "39", "49", "38;5;123", "48;2;23;25;27");
    fc.assert(fc.property(fc.array(fc.tuple(code, fc.constantFrom("text", " 日本語 🧪", " ", "")), { maxLength: 100 }), fc.integer({ min: 1, max: 100 }), (parts, size) => {
      const source = "\x1b[0m" + parts.map(([sgr, text]) => `\x1b[${sgr}m${text}`).join("") + "\x1b[0m";
      expect(painted(compact(source, size))).toEqual(painted(source));
    }), { numRuns: 300 });
  });
});

describe("SGR state", () => {
  it("requires a known reset before optimizing inherited terminal styles", () => {
    expect(applySgr(undefined, "31")).toBeUndefined();
    expect(applySgr(undefined, "0;31")).toEqual(new Map([[39, "31"]]));
    expect(applySgr(new Map(), "38;2;256;0;0")).toBeUndefined();
    expect(applySgr(new Map(), "38;5")).toBeUndefined();
    expect(applySgr(new Map(), "4:3")).toBeUndefined();
  });

  it("clears both bold and dim before replacing intensity", () => {
    expect(sgrDifference(new Map([[22, "1;2"]]), new Map([[22, "2"]]))).toBe("\x1b[22;2m");
  });
});
