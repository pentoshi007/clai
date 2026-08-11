import { describe, expect, it } from "vitest";
import type { ConfirmRequest } from "../../../src/ui-core/controllers/overlay-controller.js";
import {
  confirmKey,
  confirmRowsWanted,
  confirmView,
} from "../../../src/classic/panels/confirm-panel.js";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import { createHarness, ink, rowsOf } from "./harness.js";

function render(request: ConfirmRequest, rows = 8, columns = 80) {
  const frame = confirmView({ ink, columns, rows, request });
  return { frame, rows: rowsOf(panelFrameRows(frame).rows) };
}

describe("confirm rows", () => {
  it("renders the request prompt verbatim", () => {
    const prompt = "Run shell.exec rm -rf ./build?";
    const { rows } = render({ kind: "tool", prompt });
    expect(rows[1]).toContain(prompt);
  });

  it("uses the warning glyph, the activity border, and the y/n hints", () => {
    const { frame, rows } = render({ kind: "tool", prompt: "Run tool?" });
    expect(frame.title).toBe("⚠ Approve tool");
    expect(frame.borderColor).toBe("activity");
    expect(frame.hints).toEqual(["y/n", "esc deny"]);
    expect(rows[rows.length - 1]).toContain("y/n · esc deny");
  });

  it("adds the preview action only when the request carries a path", () => {
    const withPath = render({ kind: "tool", prompt: "DELETE?", viewPath: "/tmp/x" });
    expect(withPath.rows.join("\n")).toContain("v preview");
    expect(withPath.frame.hints).toEqual(["y/n/v", "esc deny"]);
    expect(render({ kind: "tool", prompt: "DELETE?" }).rows.join("\n")).not.toContain("v preview");
  });

  it("renders the plan variant action row", () => {
    const { frame, rows } = render({ kind: "plan", prompt: "8 tasks · add pagination" });
    expect(frame.title).toBe("⚠ Plan ready");
    expect(rows.join("\n")).toContain("i implement");
    expect(rows.join("\n")).toContain("d discard");
    expect(rows.join("\n")).toContain("s suggest changes");
    expect(rows.join("\n")).toContain("p view");
    expect(frame.hints).toEqual(["i/d/s/p", "esc dismiss"]);
  });

  it("renders reset with a single confirm key", () => {
    const { rows, frame } = render({ kind: "reset", prompt: "Reset the session?" });
    expect(rows.join("\n")).toContain("r confirm");
    expect(frame.hints).toEqual(["r", "esc cancel"]);
  });

  it("asks for the rows its wrapped prompt needs", () => {
    const short = confirmRowsWanted({ kind: "tool", prompt: "ok?" }, 80);
    const long = confirmRowsWanted(
      { kind: "tool", prompt: "word ".repeat(120) },
      80,
    );
    expect(short).toBe(5);
    expect(long).toBeGreaterThan(short);
  });
});

describe("confirm keys", () => {
  it("resolves the tool variant and swallows everything else", async () => {
    const harness = createHarness();
    const answer = harness.overlay.openConfirm({ kind: "tool", prompt: "Run tool?" });
    expect(harness.press("z")).toBe(true);
    expect(harness.overlay.isOpen()).toBe(true);
    harness.press("y");
    await expect(answer).resolves.toBe(true);
  });

  it("denies on n", async () => {
    const harness = createHarness();
    const answer = harness.overlay.openConfirm({ kind: "tool", prompt: "Run tool?" });
    harness.press("n");
    await expect(answer).resolves.toBe(false);
  });

  it("confirms reset only with r", () => {
    expect(confirmKey({ request: { kind: "reset", prompt: "" }, chord: "y" }).effects).toEqual([]);
    expect(confirmKey({ request: { kind: "reset", prompt: "" }, chord: "r" }).effects).toEqual([
      { kind: "confirm", ok: true },
    ]);
  });

  it("maps the plan variant keys", () => {
    const plan: ConfirmRequest = { kind: "plan", prompt: "" };
    const result = (chord: string) => confirmKey({ request: plan, chord }).effects;
    expect(result("i")).toEqual([{ kind: "confirm-plan", result: "implement" }]);
    expect(result("y")).toEqual([{ kind: "confirm-plan", result: "implement" }]);
    expect(result("d")).toEqual([{ kind: "confirm-plan", result: "discard" }]);
    expect(result("s")).toEqual([{ kind: "confirm-plan", result: "suggest" }]);
    expect(result("escape")).toEqual([{ kind: "confirm-plan", result: "dismiss" }]);
    expect(result("p")).toEqual([{ kind: "view-plan" }]);
  });

  it("previews a delete without resolving the confirm", () => {
    const harness = createHarness();
    let previews = 0;
    void harness.overlay.openConfirm(
      { kind: "tool", prompt: "DELETE?", viewPath: "/tmp/x" },
      undefined,
      () => {
        previews += 1;
        harness.overlay.openPager("Preview · /tmp/x", "contents");
      },
    );
    expect(harness.press("v")).toBe(true);
    expect(previews).toBe(1);
    expect(harness.overlay.getState().kind).toBe("pager");
    harness.overlay.close();
    expect(harness.overlay.getState().kind).toBe("confirm");
  });

  it("shows plan detail without resolving the plan confirm", () => {
    const harness = createHarness();
    void harness.overlay.openPlanConfirm({ kind: "plan", prompt: "8 tasks" }, () => {
      harness.overlay.openPager("Plan", "detail", undefined, undefined, "force");
    });
    expect(harness.press("p")).toBe(true);
    expect(harness.overlay.getState().kind).toBe("pager");
    harness.overlay.close();
    expect(harness.overlay.getState().kind).toBe("confirm");
  });
});
