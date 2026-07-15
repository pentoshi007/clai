/** @jsxImportSource @opentui/react */
// Phase 6 pane-scoped selection spike (V2-060..064).
//
// V2-011/012 found that OpenTUI's BUILT-IN selection (`renderer.getSelection()`)
// never engaged under the headless test renderer, which is why Phase 6 uses a
// custom `SelectionController` driven by ordinary mouse/key events instead of
// the native selection subsystem. This drives the real `TranscriptView` (real
// layout, real `screenX`/`screenY`, real mouse + keyboard dispatch) to prove
// that path end to end: cross-block drag, double/triple click, keyboard
// extension, resize-stable anchors, clipboard copy, and OSC 52 fallback.
//
// Drag-edge autoscroll itself is native `ScrollBoxRenderable` behavior
// (V2-012 found it needs a live render loop; ManualClock + renderOnce does not
// drive it). That finding is re-checked here through the real scroll port
// registration rather than re-asserted as new evidence.
//
// Run: bun run scripts/v2-spikes/selection-controller.spike.tsx
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { asSessionId } from "../../src/app/events/app-event.js";
import { EventSequencer } from "../../src/app/events/sequencer.js";
import type { ClipboardPort } from "../../src/app/ports/clipboard-port.js";
import { createCompositionRoot } from "../../src/tui-v2/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/tui-v2/bootstrap/capabilities.js";
import { createOsc52ClipboardPort } from "../../src/tui-v2/bootstrap/osc52-clipboard.js";
import { TranscriptView } from "../../src/tui-v2/components/transcript/transcript-view.js";
import { ServicesProvider } from "../../src/tui-v2/app/providers.js";
import { extractTranscriptSemanticDocument } from "../../src/tui-v2/rendering/transcript-semantic.js";
import { themeFor } from "../../src/tui-v2/rendering/theme.js";
import { check, makeResult, measure, note, printResult, type SpikeResult } from "./harness.js";

const USER_TEXT = "ALPHA BRAVO CHARLIE";
const ASSISTANT_TEXT = "DELTA ECHO FOXTROT";

class MemoryClipboard implements ClipboardPort {
  text: string | undefined;
  async writeText(text: string): Promise<void> {
    this.text = text;
  }
}

function buildServices(clipboard: ClipboardPort) {
  return createCompositionRoot({
    persistence: {
      async saveSession() {},
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    },
    clipboard,
    capabilities: detectCapabilities({
      env: { COLORTERM: "truecolor" },
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 60,
      rows: 20,
    }),
  });
}

/** Inverse of `anchorForPoint` in `use-transcript-selection.ts`: locate the
 * screen coordinate of a known substring so a mouse event lands exactly where
 * production hit-testing would resolve it back to that same offset. */
function locate(
  renderable: Renderable,
  blockText: string,
  target: string,
  fromOffset = 0,
): { x: number; y: number } {
  const offset = blockText.indexOf(target, fromOffset);
  if (offset < 0) throw new Error(`"${target}" not found in block text: ${blockText}`);
  const lines = blockText.split("\n");
  let consumed = 0;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row]!;
    if (offset <= consumed + line.length) {
      return { x: renderable.screenX + (offset - consumed), y: renderable.screenY + row };
    }
    consumed += line.length + 1;
  }
  throw new Error(`offset ${offset} out of range for block text: ${blockText}`);
}

function findScrollBox(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable) return root;
  for (const child of root.getChildren()) {
    const found = findScrollBox(child);
    if (found) return found;
  }
  return undefined;
}

export async function runSelectionControllerSpike(): Promise<SpikeResult> {
  const result = makeResult("V2-060..064", "Pane-scoped selection controller (mouse, keyboard, clipboard)");
  const clipboard = new MemoryClipboard();
  const services = buildServices(clipboard);
  const theme = themeFor(services.capabilities.themeHint);

  const sequencer = new EventSequencer(asSessionId("selection-spike"));
  services.transcript.dispatch(sequencer.build("turn-started", { prompt: USER_TEXT }, undefined));
  services.transcript.dispatch(
    sequencer.build(
      "assistant-message",
      { messageId: sequencer.ids.message(), text: ASSISTANT_TEXT },
      undefined,
    ),
  );

  const node = createElement(ServicesProvider, {
    services,
    children: createElement(TranscriptView, { services, theme, focused: true }),
  });
  const setup = await testRender(node, { width: 60, height: 20, kittyKeyboard: true });
  const mouse = setup.mockMouse;
  const keys = setup.mockInput;

  try {
    await setup.flush();

    const state = services.transcript.getState();
    const [userId, assistantId] = state.order;
    const document = extractTranscriptSemanticDocument(state);
    const userBlock = document.blocks.find((b) => b.id === userId)!;
    const assistantBlock = document.blocks.find((b) => b.id === assistantId)!;
    const userRenderable = setup.renderer.root.findDescendantById(userId!);
    const assistantRenderable = setup.renderer.root.findDescendantById(assistantId!);
    check(result, "user item is discoverable by stable id (hit-testing precondition)", Boolean(userRenderable));
    check(result, "assistant item is discoverable by stable id (hit-testing precondition)", Boolean(assistantRenderable));
    if (!userRenderable || !assistantRenderable) return result;

    // --- V2-060/061/062: cross-block drag copies exact source-order text ---
    const dragStart = locate(userRenderable, userBlock.text, "ALPHA");
    const dragEnd = locate(assistantRenderable, assistantBlock.text, "DELTA ECHO");
    await mouse.drag(dragStart.x, dragStart.y, dragEnd.x + "DELTA ECHO".length, dragEnd.y);
    await setup.flush();

    const dragged = services.selection.selectedText();
    const expectedDragged = [
      userBlock.text.slice(userBlock.text.indexOf("ALPHA")),
      assistantBlock.text.slice(0, assistantBlock.text.indexOf("DELTA ECHO") + "DELTA ECHO".length),
    ].join("\n\n");
    check(
      result,
      "drag selects from the exact start point through the exact end point, in source order",
      dragged === expectedDragged,
    );
    check(result, "cross-block selection excludes text past the drag end", !dragged.includes("FOXTROT"));
    check(result, "selection never includes composer chrome", !dragged.includes("Type a message"));

    // --- V2-063: logical anchors are immune to a live resize ---
    setup.resize(90, 30);
    await setup.flush();
    check(result, "selection text is unchanged after a live resize (offsets are logical, not cell-based)", services.selection.selectedText() === dragged);
    setup.resize(60, 20);
    await setup.flush();

    // --- V2-064: copy() writes the exact selected text through the clipboard port ---
    const copyResult = await services.selection.copy();
    check(result, "copy() reports success", copyResult.status === "copied");
    check(result, "clipboard port receives the exact selected text", clipboard.text === dragged);

    // --- V2-062: double click selects one word ---
    services.selection.clear();
    const bravo = locate(userRenderable, userBlock.text, "BRAVO");
    await mouse.doubleClick(bravo.x, bravo.y);
    await setup.flush();
    check(result, "double-click selects exactly one word", services.selection.selectedText() === "BRAVO");

    // --- V2-062: triple click selects the full logical line ---
    services.selection.clear();
    const echo = locate(assistantRenderable, assistantBlock.text, "ECHO");
    await mouse.click(echo.x, echo.y);
    await mouse.click(echo.x, echo.y);
    await mouse.click(echo.x, echo.y);
    await setup.flush();
    check(result, "triple-click selects the full logical line", services.selection.selectedText() === ASSISTANT_TEXT);

    // --- V2-062: keyboard extension from a real chord through the router ---
    // A fresh coordinate (not "ECHO" again) avoids inheriting the triple-click
    // count from the previous step's multi-click window.
    services.selection.clear();
    const foxtrotStart = locate(assistantRenderable, assistantBlock.text, "FOXTROT");
    await mouse.click(foxtrotStart.x, foxtrotStart.y);
    await setup.flush();
    keys.pressArrow("right", { shift: true, ctrl: true });
    await setup.flush();
    check(result, "ctrl+shift+right extends a character selection by one word", services.selection.selectedText() === "FOXTROT");

    // --- V2-064: OSC 52 adapter against the real renderer, with safe fallback ---
    const fallback = new MemoryClipboard();
    const osc52 = createOsc52ClipboardPort({ renderer: setup.renderer, fallback, enabled: true });
    let osc52Threw = false;
    try {
      await osc52.writeText("OSC52-SENTINEL");
    } catch {
      osc52Threw = true;
    }
    check(result, "OSC 52 adapter never throws against a real renderer", !osc52Threw);
    check(
      result,
      "OSC 52 write reaches exactly one destination (native or fallback)",
      osc52.lastWrite?.method === "osc52" ? fallback.text === undefined : fallback.text === "OSC52-SENTINEL",
    );
    note(result, `OSC 52 path chosen in this environment: ${JSON.stringify(osc52.lastWrite)}`);

    // --- V2-063: drag-edge autoscroll wiring (native scrollTop movement is a
    // known, documented live-loop-only limitation — see ADR-007/V2-012) ---
    services.selection.clear();
    const scrollBox = findScrollBox(setup.renderer.root);
    check(result, "transcript scrollbox is reachable for scroll-port registration", Boolean(scrollBox));
    if (scrollBox) {
      const before = scrollBox.scrollTop;
      const anchor = locate(userRenderable, userBlock.text, "ALPHA");
      let autoscrollThrew = false;
      try {
        services.selection.beginDrag("transcript", { blockId: userId!, offset: 0 }, { x: anchor.x, y: 100 });
        services.selection.dragTo("transcript", { blockId: assistantId!, offset: 0 }, { x: anchor.x, y: 100 });
        await setup.flush();
        services.selection.finishDrag();
      } catch {
        autoscrollThrew = true;
      }
      check(result, "drag-edge autoscroll call path does not throw against the real scrollbox", !autoscrollThrew);
      measure(result, "scrollTopDelta", scrollBox.scrollTop - before);
      note(result, "scrollTop movement itself needs a live render loop (V2-012); unchanged here is expected, not a regression.");
    }
  } finally {
    let threw = false;
    try {
      setup.renderer.destroy();
      services.dispose();
    } catch (err) {
      threw = true;
      result.notes.push(`teardown threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    check(result, "renderer teardown did not throw", !threw);
  }
  return result;
}

if (import.meta.main) {
  const r = await runSelectionControllerSpike();
  printResult(r);
  console.log(`\n${r.passed ? "PASS" : "FAIL"}  ${r.id} — ${r.title}`);
  process.exit(r.passed ? 0 : 1);
}
