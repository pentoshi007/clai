/**
 * V2-093 — property-based fuzz for layout, event replay, Unicode, control
 * bytes, and chord normalization. Uses fast-check (already in devDeps).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  asSessionId,
  asTurnId,
  type AnyAppEvent,
} from "../../src/app/events/app-event.js";
import { createCountingIdFactory, EventSequencer } from "../../src/app/events/sequencer.js";
import { normalizeChord } from "../../src/tui-v2/actions/keymap.js";
import { computeLayout } from "../../src/tui-v2/layout/compute-layout.js";
import { detectLinks } from "../../src/tui-v2/rendering/link-detector.js";
import { sanitizeDisplayText } from "../../src/tui-v2/rendering/sanitize-display.js";
import {
  clampSemanticAnchor,
  normalizeSemanticDocument,
  semanticRangeText,
  type SemanticDocument,
} from "../../src/tui-v2/state/semantic-document.js";
import { applyAppEvent } from "../../src/tui-v2/state/transcript-reducer.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type TranscriptState,
} from "../../src/tui-v2/state/transcript-types.js";

function fold(events: readonly AnyAppEvent[]): TranscriptState {
  return events.reduce(applyAppEvent, EMPTY_TRANSCRIPT_STATE);
}

function seq() {
  return new EventSequencer(
    asSessionId("fuzz"),
    createCountingIdFactory("f-"),
    { now: () => 1 },
  );
}

describe("V2-093 fuzz suite", () => {
  it("computeLayout never produces negative rects; stacks when rows are usable", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 200 }),
        fc.boolean(),
        fc.boolean(),
        (columns, rows, planVisible, splitEnabled) => {
          const model = computeLayout({ columns, rows, planVisible, splitEnabled });
          expect(model.chat.width).toBeGreaterThanOrEqual(0);
          expect(model.chat.height).toBeGreaterThanOrEqual(0);
          expect(model.composer.height).toBeGreaterThanOrEqual(0);
          expect(model.status.height).toBeGreaterThanOrEqual(0);
          expect(model.composer.y + model.composer.height).toBe(model.rows);
          expect(
            model.status.height + model.chat.height + model.composer.height,
          ).toBe(model.rows);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("transcript reduce is deterministic under replay", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 40 }), { minLength: 0, maxLength: 30 }),
        (chunks) => {
          const s = seq();
          const turnId = asTurnId("t1");
          const events: AnyAppEvent[] = chunks.map((text) =>
            s.build("assistant-delta", { text }, turnId),
          );
          if (chunks.length > 0) {
            events.push(
              s.build(
                "assistant-message",
                { messageId: s.ids.message(), text: chunks.join("") },
                turnId,
              ),
            );
          }
          const a = fold(events);
          const b = fold(events);
          expect(a).toEqual(b);
          expect(a.lastSequence).toBe(b.lastSequence);
        },
      ),
      { numRuns: 80 },
    );
  });

  it("sanitizeDisplayText removes ESC/C0/C1 but keeps Unicode and newlines", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (body) => {
        const dirty =
          `\x1b[31m${body}\x07\x1b]0;title\x07\x00\x1f` + body + "\n\u4e2d\u6587\t";
        const clean = sanitizeDisplayText(dirty);
        expect(clean).not.toMatch(/\x1b/);
        expect(clean).not.toMatch(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f\x80-\x9f]/);
        expect(clean).toContain("\n");
        if (body.includes("\u4e2d") || dirty.includes("\u4e2d")) {
          expect(clean).toContain("\u4e2d\u6587");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("semantic anchors clamp under Unicode block text", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.integer({ min: -5, max: 200 }),
        (texts, rawOffset) => {
          const document: SemanticDocument = normalizeSemanticDocument({
            blocks: texts.map((text, i) => ({ id: `b${i}`, text })),
          });
          const blockId = document.blocks[0]!.id;
          const clamped = clampSemanticAnchor(document, {
            blockId,
            offset: rawOffset,
          });
          expect(clamped).toBeDefined();
          expect(clamped!.offset).toBeGreaterThanOrEqual(0);
          expect(clamped!.offset).toBeLessThanOrEqual(document.blocks[0]!.text.length);
          const text = semanticRangeText(document, {
            anchor: { blockId, offset: 0 },
            focus: clamped!,
          });
          expect(typeof text).toBe("string");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("normalizeChord is idempotent", () => {
    for (const chord of [
      "Ctrl+Shift+C",
      "ctrl+shift+c",
      "CTRL+J",
      "Alt+Enter",
      "meta+k",
    ]) {
      const once = normalizeChord(chord);
      expect(normalizeChord(once)).toBe(once);
      expect(once).toMatch(/^[a-z0-9+]+$/);
    }
    expect(normalizeChord("Ctrl+Shift+C")).toBe("ctrl+shift+c");
  });

  it("detectLinks never treats javascript:/data: as URLs", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (suffix) => {
        const evil = `javascript:alert(1)${suffix} data:text/html,hi`;
        const spans = detectLinks(evil);
        for (const span of spans) {
          if (span.kind === "url") {
            expect(span.value.startsWith("http://") || span.value.startsWith("https://")).toBe(
              true,
            );
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});
