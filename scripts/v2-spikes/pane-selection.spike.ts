// V2-011 / V2-012 — Pane-scoped selection + drag-edge autoscroll spike.
//
// Two side-by-side scroll panes (chat | plan) with sentinel rows. A drag that
// starts in the chat pane and crosses into the plan pane must copy ONLY chat
// text (SEL-002/003, ADR-005). Then a drag past the pane's bottom edge must
// autoscroll ONLY that pane (SEL-006).
//
// The PASS/FAIL of the selection check is itself the ADR-005 evidence:
//   PASS  -> OpenTUI built-in selection already enforces pane ownership.
//   FAIL  -> a custom clai selection coordinator is required.
import { createTestRenderer } from "@opentui/core/testing";
import { ManualClock } from "@opentui/core/testing";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { check, makeResult, measure, note, type SpikeResult } from "./harness.js";

const W = 80;
const H = 20;
const PANE_W = 40;
const ROWS = 60;

function fillPane(renderer: any, scroll: ScrollBoxRenderable, prefix: string): void {
  for (let i = 0; i < ROWS; i++) {
    const row = new TextRenderable(renderer, {
      content: `${prefix}-LINE-${String(i).padStart(2, "0")} lorem ipsum sentinel`,
    });
    row.selectable = true;
    scroll.add(row);
  }
}

export async function runPaneSelectionSpike(): Promise<SpikeResult> {
  const result = makeResult("V2-011/012", "Pane-scoped selection + drag-edge autoscroll");
  const clock = new ManualClock();
  const setup = await createTestRenderer({ width: W, height: H, useMouse: true, clock });
  try {
    const rowContainer = new BoxRenderable(setup.renderer, {
      width: W,
      height: H,
      flexDirection: "row",
    });
    setup.renderer.root.add(rowContainer);

    const chat = new ScrollBoxRenderable(setup.renderer, {
      width: PANE_W,
      height: H,
      scrollY: true,
      viewportCulling: true,
    });
    const plan = new ScrollBoxRenderable(setup.renderer, {
      width: PANE_W,
      height: H,
      scrollY: true,
      viewportCulling: true,
    });
    rowContainer.add(chat);
    rowContainer.add(plan);
    fillPane(setup.renderer, chat, "CHAT");
    fillPane(setup.renderer, plan, "PLAN");
    await setup.renderOnce();

    // --- SEL-002/003: drag from chat crossing into plan ---
    await setup.mockMouse.drag(2, 2, W - 4, H - 4);
    await setup.flush();
    const selection = setup.renderer.getSelection();
    const selectedText = selection?.getSelectedText() ?? "";
    const hasChat = selectedText.includes("CHAT-LINE");
    const hasPlan = selectedText.includes("PLAN-LINE");

    check(result, "a selection was produced by the drag", selectedText.length > 0,
      `selectedTextLen=${selectedText.length}`);
    check(result, "selection includes chat content", hasChat);
    check(result, "selection excludes plan content (pane-scoped copy)", !hasPlan);
    measure(result, "selectedTextLen", selectedText.length);
    if (selectedText.length === 0) {
      note(result, "ADR-005 FINDING: OpenTUI built-in selection did not engage under the");
      note(result, "headless test renderer (mockMouse.drag and direct startSelection both");
      note(result, "yield empty text). Pane-scoped selection needs interactive/live-loop");
      note(result, "validation and most likely a custom clai selection coordinator.");
    } else {
      note(result, hasPlan
        ? "Built-in selection bled across panes -> ADR-005 custom coordinator REQUIRED."
        : "Built-in selection stayed pane-scoped -> ADR-005 built-in path viable.");
    }

    setup.renderer.clearSelection();
    await setup.renderOnce();

    // --- SEL-006: drag past bottom edge autoscrolls only the chat pane ---
    const chatTop0 = chat.scrollTop;
    const planTop0 = plan.scrollTop;
    chat.startAutoScroll(2, H + 3); // pointer below the pane bottom
    for (let i = 0; i < 60; i++) {
      chat.updateAutoScroll(2, H + 3);
      clock.advance(16);
      await setup.renderOnce();
    }
    chat.stopAutoScroll();
    await setup.renderOnce();

    const chatScrolled = chat.scrollTop - chatTop0;
    const planScrolled = plan.scrollTop - planTop0;
    check(result, "chat pane autoscrolled downward", chatScrolled > 0,
      `chatScrollDelta=${chatScrolled}`);
    check(result, "plan pane did NOT autoscroll", planScrolled === 0,
      `planScrollDelta=${planScrolled}`);
    measure(result, "chatScrollDelta", chatScrolled);
    measure(result, "planScrollDelta", planScrolled);
    if (chatScrolled === 0) {
      note(result, "SEL-006 FINDING: startAutoScroll/updateAutoScroll did not move scrollTop");
      note(result, "under ManualClock + renderOnce; autoscroll is driven by the live render");
      note(result, "loop and needs an interactive/live-loop harness to validate.");
    }
    return result;
  } finally {
    setup.renderer.destroy();
  }
}
