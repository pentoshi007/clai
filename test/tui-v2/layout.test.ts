import { describe, expect, it } from "vitest";
import {
  CHAT_MIN_WIDTH_SPLIT,
  COMPOSER_MIN_HEIGHT,
  MIN_CHAT_ROWS,
  PLAN_MAX_WIDTH,
  PLAN_MIN_WIDTH,
  computeLayout,
  type LayoutModel,
} from "../../src/tui-v2/layout/compute-layout.js";

function noGapsOrOverlap(model: LayoutModel): void {
  // status, chat, composer stack vertically and fully cover the terminal.
  expect(model.status.y).toBe(0);
  expect(model.chat.y).toBe(model.status.height);
  expect(model.composer.y).toBe(model.chat.y + model.chat.height);
  expect(model.composer.y + model.composer.height).toBe(model.rows);
}

describe("computeLayout density classification", () => {
  it("classifies narrow terminals as compact with plan overlay", () => {
    const model = computeLayout({
      columns: 70,
      rows: 30,
      planVisible: true,
      splitEnabled: true,
    });
    expect(model.density).toBe("compact");
    expect(model.plan.placement).toBe("overlay");
    expect(model.chat.width).toBe(70);
    expect(model.statusCondensed).toBe(true);
  });

  it("classifies short terminals as compact regardless of width", () => {
    const model = computeLayout({ columns: 200, rows: 18 });
    expect(model.density).toBe("compact");
  });

  it("classifies mid terminals as single column", () => {
    const model = computeLayout({ columns: 100, rows: 40 });
    expect(model.density).toBe("single");
    expect(model.chat.width).toBe(100);
  });

  it("classifies wide terminals as wide", () => {
    const model = computeLayout({ columns: 160, rows: 50 });
    expect(model.density).toBe("wide");
    expect(model.statusCondensed).toBe(false);
  });
});

describe("computeLayout split view", () => {
  it("splits chat and plan on wide terminals when enabled and requested", () => {
    const model = computeLayout({
      columns: 160,
      rows: 50,
      planVisible: true,
      splitEnabled: true,
    });
    expect(model.plan.placement).toBe("split");
    expect(model.plan.width).toBeGreaterThanOrEqual(PLAN_MIN_WIDTH);
    expect(model.plan.width).toBeLessThanOrEqual(PLAN_MAX_WIDTH);
    expect(model.chat.width).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH_SPLIT);
    // chat + divider + plan == columns
    expect(model.chat.width + 1 + model.plan.width).toBe(160);
    // plan sits to the right of chat, same vertical band.
    expect(model.plan.x).toBe(model.chat.width + 1);
    expect(model.plan.y).toBe(model.chat.y);
  });

  it("falls back to overlay when split is disabled", () => {
    const model = computeLayout({
      columns: 160,
      rows: 50,
      planVisible: true,
      splitEnabled: false,
    });
    expect(model.plan.placement).toBe("overlay");
    expect(model.chat.width).toBe(160);
  });

  it("keeps chat above its split minimum by shrinking the plan", () => {
    const model = computeLayout({
      columns: 120,
      rows: 40,
      planVisible: true,
      splitEnabled: true,
    });
    if (model.plan.placement === "split") {
      expect(model.chat.width).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH_SPLIT);
      expect(model.plan.width).toBeGreaterThanOrEqual(PLAN_MIN_WIDTH);
    }
  });

  it("hides the plan when not requested", () => {
    const model = computeLayout({ columns: 160, rows: 50, splitEnabled: true });
    expect(model.plan.placement).toBe("hidden");
    expect(model.chat.width).toBe(160);
  });
});

describe("computeLayout vertical budget", () => {
  it("stacks status/chat/composer without gaps at standard size", () => {
    noGapsOrOverlap(computeLayout({ columns: 100, rows: 40 }));
  });

  it("keeps the chat floor and shrinks the composer on very short terminals", () => {
    const model = computeLayout({ columns: 100, rows: 8 });
    expect(model.showOptionalChrome).toBe(false);
    expect(model.composer.height).toBeGreaterThanOrEqual(COMPOSER_MIN_HEIGHT);
    expect(model.chat.height).toBeGreaterThanOrEqual(MIN_CHAT_ROWS);
    noGapsOrOverlap(model);
  });

  it("never produces negative dimensions at tiny sizes", () => {
    for (const rows of [0, 1, 2, 3, 5]) {
      const model = computeLayout({ columns: 40, rows });
      expect(model.chat.height).toBeGreaterThanOrEqual(0);
      expect(model.composer.height).toBeGreaterThanOrEqual(0);
      expect(model.status.height).toBeGreaterThanOrEqual(0);
    }
  });

  it("marks optional chrome present when there is room", () => {
    const model = computeLayout({ columns: 100, rows: 40 });
    expect(model.showOptionalChrome).toBe(true);
    expect(model.composer.height).toBe(3);
  });
});

describe("computeLayout overlay portal", () => {
  it("always spans the full terminal", () => {
    const model = computeLayout({ columns: 133, rows: 47 });
    expect(model.overlay).toEqual({ x: 0, y: 0, width: 133, height: 47 });
  });
});

describe("computeLayout determinism", () => {
  it("is a pure function of its input", () => {
    const input = {
      columns: 140,
      rows: 45,
      planVisible: true,
      splitEnabled: true,
    };
    expect(computeLayout(input)).toEqual(computeLayout(input));
  });
});
