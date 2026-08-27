import { describe, expect, it } from "vitest";
import {
  resolveTranscriptScrollIntent,
  shouldPinTranscriptBottom,
} from "../../../src/ui-core/state/transcript-window.js";

describe("transcript scroll intent", () => {
  it("leaves the live tail on the first upward wheel step", () => {
    expect(resolveTranscriptScrollIntent(120, 120, -3)).toEqual({
      nextScrollTop: 117,
      leaveTail: true,
      reachedOlderEdge: false,
      reachedNewerEdge: false,
      atBottom: false,
    });
  });

  it("leaves follow even for a single upward key row", () => {
    const intent = resolveTranscriptScrollIntent(120, 120, -1);
    expect(intent.nextScrollTop).toBe(119);
    expect(intent.leaveTail).toBe(true);
    expect(intent.atBottom).toBe(false);
  });

  it("continues upward and downward movement in the middle", () => {
    expect(resolveTranscriptScrollIntent(60, 120, -3).nextScrollTop).toBe(57);
    expect(resolveTranscriptScrollIntent(60, 120, 3).nextScrollTop).toBe(63);
  });

  it("re-engages only after downward movement reaches the exact bottom", () => {
    const nearBottom = resolveTranscriptScrollIntent(116, 120, 3);
    expect(nearBottom.nextScrollTop).toBe(119);
    expect(nearBottom.atBottom).toBe(false);

    const bottom = resolveTranscriptScrollIntent(117, 120, 3);
    expect(bottom).toEqual({
      nextScrollTop: 120,
      leaveTail: false,
      reachedOlderEdge: false,
      reachedNewerEdge: true,
      atBottom: true,
    });
  });

  it("reports window edges while clamping oversized movement", () => {
    expect(resolveTranscriptScrollIntent(2, 120, -20)).toMatchObject({
      nextScrollTop: 0,
      leaveTail: true,
      reachedOlderEdge: true,
    });
    expect(resolveTranscriptScrollIntent(118, 120, 20)).toMatchObject({
      nextScrollTop: 120,
      reachedNewerEdge: true,
      atBottom: true,
    });
  });
});

describe("bottom-pin gating", () => {
  it("never pins when follow is off", () => {
    expect(
      shouldPinTranscriptBottom({
        following: false,
        pointerGestureActive: false,
        forced: true,
      }),
    ).toBe(false);
  });

  it("skips automatic pins while a pointer gesture is live", () => {
    expect(
      shouldPinTranscriptBottom({
        following: true,
        pointerGestureActive: true,
        forced: false,
      }),
    ).toBe(false);
  });

  it("lets an explicit End / Ctrl+D jump outrank a stale pointer gesture", () => {
    // A press released outside the transcript never delivers mouse-up there,
    // so the flag can stay set; an explicit jump must still reach the bottom.
    expect(
      shouldPinTranscriptBottom({
        following: true,
        pointerGestureActive: true,
        forced: true,
      }),
    ).toBe(true);
  });

  it("pins automatically once no gesture is in flight", () => {
    expect(
      shouldPinTranscriptBottom({
        following: true,
        pointerGestureActive: false,
        forced: false,
      }),
    ).toBe(true);
  });
});
