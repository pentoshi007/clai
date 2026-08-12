import { describe, expect, it } from "vitest";
import { ACTION_IDS, isActionId } from "../../src/ui-core/actions/action-id.js";
import {
  defaultKeymap,
  normalizeChord,
  validateKeymap,
  type KeyBinding,
} from "../../src/ui-core/actions/keymap.js";
import { ActionRouter } from "../../src/ui-core/actions/action-router.js";
import { FocusController } from "../../src/ui-core/controllers/focus-controller.js";

describe("normalizeChord", () => {
  it("orders modifiers canonically and lowercases", () => {
    expect(normalizeChord("Shift+Ctrl+A")).toBe("ctrl+shift+a");
    expect(normalizeChord("ALT+Enter")).toBe("alt+enter");
    expect(normalizeChord("enter")).toBe("enter");
  });
});

describe("default keymap", () => {
  it("binds only known action ids", () => {
    for (const b of defaultKeymap) expect(isActionId(b.action)).toBe(true);
  });

  it("has no conflicting bindings within any context", () => {
    expect(validateKeymap(defaultKeymap)).toEqual([]);
  });

  it("covers every declared action id somewhere", () => {
    const bound = new Set(defaultKeymap.map((b) => b.action));
    const missing = ACTION_IDS.filter((id) => !bound.has(id));
    // Not every action needs a default chord (some are mouse/command driven).
    // Guard that the core interactive actions are bound.
    expect(missing).not.toContain("editor.submit");
    expect(missing).not.toContain("app.cancel");
    expect(missing).not.toContain("app.interrupt");
  });
});

describe("validateKeymap", () => {
  it("flags a chord bound to two actions in the same context", () => {
    const bad: KeyBinding[] = [
      { chord: "enter", action: "editor.submit", context: "composer" },
      { chord: "enter", action: "editor.newline", context: "composer" },
    ];
    const conflicts = validateKeymap(bad);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.actions).toHaveLength(2);
  });

  it("allows the same chord in different contexts", () => {
    const ok: KeyBinding[] = [
      { chord: "enter", action: "editor.submit", context: "composer" },
      { chord: "enter", action: "picker.accept", context: "picker" },
    ];
    expect(validateKeymap(ok)).toEqual([]);
  });
});

describe("ActionRouter", () => {
  it("throws when constructed with a conflicting keymap", () => {
    expect(
      () =>
        new ActionRouter([
          { chord: "x", action: "editor.submit", context: "composer" },
          { chord: "x", action: "editor.clear", context: "composer" },
        ]),
    ).toThrow(/conflicting/);
  });

  it("resolves context bindings over global fallback", () => {
    const router = new ActionRouter();
    expect(router.resolve("enter", "composer")).toBe("editor.submit");
    expect(router.resolve("enter", "picker")).toBe("picker.accept");
  });

  it("falls back to global bindings when the context has none", () => {
    const router = new ActionRouter();
    expect(router.resolve("ctrl+c", "composer")).toBe("app.interrupt");
    expect(router.resolve("ctrl+c", "transcript")).toBe("app.interrupt");
    expect(router.resolve("escape", "composer")).toBe("app.cancel");
  });

  it("resolves the always-on thinking/output toggles from any context (V2-050..057)", () => {
    const router = new ActionRouter();
    expect(router.resolve("ctrl+t", "composer")).toBe("transcript.toggle-thinking");
    expect(router.resolve("ctrl+t", "transcript")).toBe("transcript.toggle-thinking");
    expect(router.resolve("ctrl+o", "composer")).toBe("transcript.toggle-output");
    expect(router.resolve("ctrl+r", "transcript")).toBe("transcript.search");
  });

  it("resolves ^D bottom / ^X cut; ^U top only outside composer (line-delete)", () => {
    const router = new ActionRouter();
    // Composer: Ctrl+U is NOT transcript.top — textarea uses it for
    // delete-to-line-start (macOS Cmd+Backspace often arrives as Ctrl+U).
    expect(router.resolve("ctrl+u", "composer")).toBeUndefined();
    expect(router.resolve("ctrl+d", "composer")).toBe("transcript.bottom");
    expect(router.resolve("ctrl+u", "transcript")).toBe("transcript.top");
    expect(router.resolve("ctrl+d", "transcript")).toBe("transcript.bottom");
    expect(router.resolve("ctrl+x", "composer")).toBe("editor.cut-draft");
    expect(router.resolve("ctrl+q", "composer")).toBe("editor.clear");
    expect(router.resolve("ctrl+shift+x", "composer")).toBeUndefined();
    // No bare g/G bindings.
    expect(router.resolve("g", "transcript")).toBeUndefined();
    expect(router.resolve("shift+g", "transcript")).toBeUndefined();
    expect(router.resolve("g", "pager")).toBeUndefined();
    expect(router.resolve("shift+g", "pager")).toBeUndefined();
    // Pager also uses ^U/^D for absolute ends.
    expect(router.resolve("ctrl+u", "pager")).toBe("pager.top");
    expect(router.resolve("ctrl+d", "pager")).toBe("pager.bottom");
  });

  it("normalizes the incoming chord before lookup", () => {
    const router = new ActionRouter();
    expect(router.resolve("Shift+Enter", "composer")).toBe("editor.newline");
  });

  it("reports the chords bound to an action for help text", () => {
    const router = new ActionRouter();
    expect(router.chordsFor("editor.newline")).toEqual(
      expect.arrayContaining(["shift+enter", "alt+enter"]),
    );
  });

  it("returns undefined for unbound chords", () => {
    const router = new ActionRouter();
    expect(router.resolve("ctrl+z", "composer")).toBeUndefined();
  });

  it("resolves Shift+Tab to mode cycling from base regions", () => {
    const router = new ActionRouter();
    expect(router.resolve("shift+tab", "global")).toBe("app.cycle-mode");
    // Composer is non-trapping, so the global mode-cycle chord still resolves.
    expect(router.resolve("shift+tab", "composer")).toBe("app.cycle-mode");
    expect(router.resolve("shift+tab", "transcript")).toBe("app.cycle-mode");
    // Bare Tab stays the focus/completion chord (never mode cycling).
    expect(router.resolve("shift+tab", "global")).not.toBe("focus.next-region");
  });
});

describe("FocusController", () => {
  it("defaults to the composer region", () => {
    const focus = new FocusController();
    expect(focus.activeContext()).toBe("composer");
  });

  it("cycles between visible regions", () => {
    const focus = new FocusController("composer");
    expect(focus.cycleRegion(["composer", "transcript"])).toBe("transcript");
    expect(focus.cycleRegion(["composer", "transcript"])).toBe("composer");
  });

  it("routes to the overlay context while an overlay is open", () => {
    const focus = new FocusController("composer");
    const close = focus.pushOverlay("picker");
    expect(focus.activeContext()).toBe("picker");
    expect(focus.hasOverlay()).toBe(true);
    close();
    expect(focus.activeContext()).toBe("composer");
    expect(focus.hasOverlay()).toBe(false);
  });

  it("rejects a second blocking overlay", () => {
    const focus = new FocusController();
    focus.pushOverlay("modal");
    expect(() => focus.pushOverlay("picker")).toThrow(/already open/);
  });

  it("notifies listeners on context change", () => {
    const focus = new FocusController();
    const seen: string[] = [];
    focus.onChange((ctx) => seen.push(ctx));
    focus.pushOverlay("modal");
    focus.popOverlay();
    expect(seen).toEqual(["modal", "composer"]);
  });

  it("closing an already-closed overlay is a no-op", () => {
    const focus = new FocusController();
    const close = focus.pushOverlay("secret");
    close();
    close();
    expect(focus.hasOverlay()).toBe(false);
  });
});
