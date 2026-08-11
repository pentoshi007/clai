import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_TOAST_ROWS,
  PLAN_MAX_ROWS,
  QUEUE_MAX_ROWS,
  allocateChrome,
  type ChromeDemand,
  type ChromeLayout,
  type StatusRowsWanted,
} from "../../../src/classic/chrome/row-budget.js";

function demand(over: Partial<ChromeDemand> = {}): ChromeDemand {
  return {
    rows: 24,
    columns: 80,
    composerTextRows: 1,
    statusRowsWanted: 1,
    toastCount: 0,
    queueCount: 0,
    responderVisible: false,
    planVisible: false,
    planRowsWanted: 0,
    overlay: undefined,
    ...over,
  };
}

const demandArb = fc.record({
  rows: fc.integer({ min: 1, max: 200 }),
  columns: fc.integer({ min: 20, max: 300 }),
  composerTextRows: fc.integer({ min: 1, max: 40 }),
  statusRowsWanted: fc.constantFrom<StatusRowsWanted>(1, 2, 3),
  toastCount: fc.integer({ min: 0, max: 5 }),
  queueCount: fc.integer({ min: 0, max: 12 }),
  responderVisible: fc.boolean(),
  planVisible: fc.boolean(),
  planRowsWanted: fc.integer({ min: 0, max: 40 }),
  overlay: fc.option(
    fc.record({
      kind: fc.constantFrom("picker" as const, "pager" as const, "jobs" as const),
      rowsWanted: fc.integer({ min: 0, max: 60 }),
    }),
    { nil: undefined },
  ),
});

const parts = (layout: ChromeLayout): number[] => [
  layout.composer,
  layout.status,
  layout.toast,
  layout.queue,
  layout.responder,
  layout.plan,
  layout.overlay,
  layout.liveTail,
];

describe("allocateChrome invariants", () => {
  it("uses the full terminal row budget", () => {
    fc.assert(
      fc.property(demandArb, (input) => {
        const layout = allocateChrome(input);
        expect(layout.total).toBeLessThanOrEqual(input.rows);
        expect(layout.total).toBeLessThanOrEqual(Math.max(input.rows, 0));
      }),
      { numRuns: 5_000 },
    );
  });

  it("never allocates a negative or fractional section", () => {
    fc.assert(
      fc.property(demandArb, (input) => {
        for (const value of parts(allocateChrome(input))) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it("has a total equal to the sum of its sections", () => {
    fc.assert(
      fc.property(demandArb, (input) => {
        const layout = allocateChrome(input);
        expect(parts(layout).reduce((a, b) => a + b, 0)).toBe(layout.total);
      }),
      { numRuns: 2_000 },
    );
  });

  it("respects every documented cap", () => {
    fc.assert(
      fc.property(demandArb, (input) => {
        const layout = allocateChrome(input);
        expect(layout.toast).toBeLessThanOrEqual(MAX_TOAST_ROWS);
        expect(layout.queue).toBeLessThanOrEqual(QUEUE_MAX_ROWS);
        expect(layout.plan).toBeLessThanOrEqual(PLAN_MAX_ROWS);
        expect(layout.responder).toBeLessThanOrEqual(1);
        expect(layout.status).toBeLessThanOrEqual(input.statusRowsWanted);
        if (input.overlay) {
          expect(layout.overlay).toBeLessThanOrEqual(Math.floor(input.rows * 0.6));
        } else {
          expect(layout.overlay).toBe(0);
        }
        if (input.queueCount === 0) expect(layout.queue).toBe(0);
        if (!input.planVisible) expect(layout.plan).toBe(0);
        if (!input.responderVisible) expect(layout.responder).toBe(0);
      }),
      { numRuns: 2_000 },
    );
  });

  it("is monotone: more rows never shrinks the live tail", () => {
    fc.assert(
      fc.property(demandArb, (input) => {
        let previous = -1;
        for (let rows = 1; rows <= 60; rows += 1) {
          const layout = allocateChrome({ ...input, rows });
          expect(layout.liveTail).toBeGreaterThanOrEqual(previous);
          previous = layout.liveTail;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(demandArb, (input) => {
        expect(allocateChrome(input)).toEqual(allocateChrome(input));
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("degradation golden table for rows 1-10", () => {
  const golden: readonly (readonly [number, Partial<ChromeLayout>])[] = [
    [1, { composer: 1, status: 0, liveTail: 0, total: 1, degraded: true }],
    [2, { composer: 2, status: 0, liveTail: 0, total: 2, degraded: true }],
    [3, { composer: 3, status: 0, liveTail: 0, total: 3, degraded: true }],
    [4, { composer: 4, status: 0, liveTail: 0, total: 4, degraded: true }],
    [5, { composer: 5, status: 0, liveTail: 0, total: 5, degraded: true }],
    [6, { composer: 5, status: 1, liveTail: 0, total: 6, degraded: true }],
    [7, { composer: 5, status: 1, liveTail: 1, total: 7, degraded: false }],
    [8, { composer: 6, status: 1, liveTail: 1, total: 8, degraded: false }],
    [9, { composer: 7, status: 1, liveTail: 1, total: 9, degraded: false }],
    [10, { composer: 8, status: 1, liveTail: 1, total: 10, degraded: false }],
  ];

  for (const [rows, expected] of golden) {
    it(`rows=${rows}`, () => {
      const layout = allocateChrome(demand({ rows, composerTextRows: 40 }));
      expect(layout).toMatchObject(expected);
      expect(layout.total).toBeLessThanOrEqual(rows);
    });
  }
});

describe("priority order", () => {
  it("keeps the composer at three rows and status at one with an overlay open at rows 12", () => {
    const layout = allocateChrome(
      demand({
        rows: 12,
        composerTextRows: 1,
        overlay: { kind: "picker", rowsWanted: 20 },
      }),
    );
    expect(layout.composer).toBeGreaterThanOrEqual(3);
    expect(layout.status).toBeGreaterThanOrEqual(1);
    expect(layout.overlay).toBe(6);
    expect(layout.degraded).toBe(true);
  });

  it("gives the status its mandatory row before the overlay", () => {
    const layout = allocateChrome(
      demand({ rows: 8, overlay: { kind: "pager", rowsWanted: 40 } }),
    );
    expect(layout.status).toBe(1);
    expect(layout.overlay).toBe(2);
  });

  it("expands the status only after the plan is served", () => {
    const layout = allocateChrome(
      demand({ rows: 24, statusRowsWanted: 3, planVisible: true, planRowsWanted: 8 }),
    );
    expect(layout.plan).toBe(10);
    expect(layout.status).toBe(3);
    expect(layout.degraded).toBe(false);
  });

  it("marks degraded when the status cannot reach its density", () => {
    const layout = allocateChrome(
      demand({ rows: 7, statusRowsWanted: 3, composerTextRows: 3 }),
    );
    expect(layout.status).toBeLessThan(3);
    expect(layout.degraded).toBe(true);
  });

  it("marks degraded when a visible plan gets nothing", () => {
    const layout = allocateChrome(demand({ rows: 5, planVisible: true, planRowsWanted: 4 }));
    expect(layout.plan).toBe(0);
    expect(layout.degraded).toBe(true);
  });

  it("caps the queue panel at its header plus four rows", () => {
    const layout = allocateChrome(demand({ rows: 40, queueCount: 12 }));
    expect(layout.queue).toBe(QUEUE_MAX_ROWS);
  });

  it("caps toasts at two rows", () => {
    expect(allocateChrome(demand({ rows: 40, toastCount: 5 })).toast).toBe(MAX_TOAST_ROWS);
  });

  it("gives the composer at most 40 per cent of the screen", () => {
    const layout = allocateChrome(demand({ rows: 50, composerTextRows: 40 }));
    expect(layout.composer).toBe(4 + 18);
  });

  it("clamps the composer to the 18-row text cap", () => {
    const layout = allocateChrome(demand({ rows: 200, composerTextRows: 100 }));
    expect(layout.composer).toBe(22);
  });
});
