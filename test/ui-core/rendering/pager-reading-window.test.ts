import { describe, expect, it } from "vitest";
import { createTextPagerSource } from "../../../src/ui-core/rendering/artifact-pager-source.js";
import { canExtend, refreshReadingWindow, shiftReadingWindow, type ReadingWindow, type ScrollDirection } from "../../../src/ui-core/rendering/pager-reading-window.js";

const text = `${"\t日本🙂\n".repeat(2345)}tail`;
const bytes = Buffer.from(text);
function utf8Boundary(offset: number): number {
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
  return offset;
}
function assertWindow(window: ReadingWindow): void {
  expect(window.parts?.length ?? 1).toBeLessThanOrEqual(3);
  expect(window.body).toBe(bytes.toString("utf8", utf8Boundary(window.offset), utf8Boundary(window.nextOffset)));
}

describe("bounded continuous reading", () => {
  it.each([0, 1, 1923, bytes.length - 1025])("keeps exact contiguous bytes from offset %d in both directions", async start => {
    const source = createTextPagerSource(text, "fixture", 1025);
    try {
      let window: ReadingWindow = await source.readPage(start);
      for (const direction of [-1, 1, -1] as const satisfies readonly ScrollDirection[]) {
        let steps = 0;
        while (canExtend(window, direction)) {
          const prev = window;
          ({ window } = await shiftReadingWindow(source, window, direction));
          expect(window.offset).toBeLessThan(prev.nextOffset);
          expect(window.nextOffset).toBeGreaterThan(prev.offset);
          assertWindow(window);
          assertWindow(await refreshReadingWindow(source, window));
          expect(++steps).toBeLessThan(bytes.length / 400);
        }
        expect(direction < 0 ? window.offset : window.nextOffset).toBe(direction < 0 ? 0 : bytes.length);
      }
    } finally { source.dispose(); }
  });
});
