/** @jsxImportSource @opentui/react */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { TextRenderable } from "@opentui/core";
import { patchOpenTuiTextContent } from "../../src/tui-v2/bootstrap/patch-opentui-text.js";
import { OverlayHost } from "../../src/tui-v2/components/overlay/overlay-host.js";
import { TerminalDimensionsContext } from "../../src/tui-v2/hooks/terminal-dimensions.js";
import { OverlayController } from "../../src/ui-core/controllers/overlay-controller.js";
import { FocusController } from "../../src/ui-core/controllers/focus-controller.js";
import { ActionRouter } from "../../src/ui-core/actions/action-router.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { createArtifactPagerSource, type ArtifactPagerSource } from "../../src/ui-core/rendering/artifact-pager-source.js";
import type { AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { check, makeResult, type SpikeResult } from "./harness.js";

const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\ufffd]/;
const ESCAPED_TEXT = "\x1b[?1049l\x1b[2J\x1b[H\x1b[32m✓ tests passed\x1b[0m\r\nplain\x00 text\x1b_PNG payload\x1b\\";

export async function runPagerLiveSpike(): Promise<SpikeResult> {
  patchOpenTuiTextContent();
  const result = makeResult("V2-PAGER-LIVE", "pager controls, live updates and overlay isolation");
  const directory = await mkdtemp(join(tmpdir(), "clai-pager-native-"));
  const path = join(directory, "output.txt");
  const listeners = new Set<() => void>();
  let growing = true;
  let reads = 0;
  let releaseRead: (() => void) | undefined;
  const pendingReads = new Set<Promise<unknown>>();
  const trackRead = <T,>(read: () => Promise<T>): Promise<T> => {
    const pending = read();
    pendingReads.add(pending);
    void pending.then(() => pendingReads.delete(pending), () => pendingReads.delete(pending));
    return pending;
  };
  const artifact = createArtifactPagerSource(path);
  const source: ArtifactPagerSource = {
    ...artifact,
    readTail: () => trackRead(async () => {
      reads += 1;
      if (releaseRead) await new Promise<void>((resolve) => { releaseRead = resolve; });
      return artifact.readTail!();
    }),
    isGrowing: () => growing,
    watch(onChange) {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
  };
  const overlay = new OverlayController(new FocusController());
  const services = {
    overlay,
    router: new ActionRouter(),
    capabilities: { colorMode: "truecolor" },
  } as AppServices;
  const theme = themeFor("dark");
  let updateChat: (text: string) => void = () => undefined;
  function Harness() {
    const dimensions = useTerminalDimensions();
    const [chat, setChat] = useState("MAIN CHAT");
    updateChat = setChat;
    return (
      <TerminalDimensionsContext.Provider value={dimensions}>
        <box width="100%" height="100%" flexDirection="column">
          <text content={chat} />
          <text id="content-boundary" content={ESCAPED_TEXT} />
          <text id="children-boundary">{ESCAPED_TEXT}</text>
          <text id="chunks-boundary">
            <span fg={theme.success}>{"✓ \x1b["}</span>
            <span fg={theme.cyan}>{"32mtests\x1b]0;window"}</span>
            <span fg={theme.foreground}>{" title\x07 passed"}</span>
          </text>
          <OverlayHost services={services} theme={theme} width={dimensions.width} height={dimensions.height} />
        </box>
      </TerminalDimensionsContext.Provider>
    );
  }

  const setup = await testRender(<Harness />, { width: 80, height: 24, useThread: false });
  const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 10; pass += 1) {
      await act(async () => { await Promise.allSettled(pendingReads); });
      await act(async () => { await setup.flush(); });
      if (pendingReads.size === 0) {
        await act(async () => { await setup.flush(); });
        return;
      }
    }
    throw new Error("pager artifact reads did not settle");
  };
  const notify = (): void => { for (const listener of listeners) listener(); };
  const frameCheck = (label: string): string => {
    const frame = setup.captureCharFrame();
    check(result, `${label}: overlay fully covers the updating chat`, !frame.includes("MAIN CHAT"));
    check(result, `${label}: no terminal controls or replacement characters`, !CONTROLS.test(frame));
    const rows = frame.split("\n");
    const top = rows.findIndex((row) => row.includes("╭"));
    const bottom = rows.findIndex((row) => row.includes("╰"));
    const left = rows[top]?.indexOf("╭") ?? -1;
    const right = rows[top]?.indexOf("╮") ?? -1;
    check(result, `${label}: pager borders remain intact`, top >= 0 && bottom > top && right > left &&
      rows.slice(top + 1, bottom).every((row) => row[left] === "│" && row[right] === "│"));
    return frame;
  };
  try {
    await flush();
    for (const id of ["content-boundary", "children-boundary", "chunks-boundary"]) {
      const node = setup.renderer.root.findDescendantById(id) as TextRenderable;
      const text = node.textBuffer.getPlainText();
      check(result, `${id}: sanitized before native text storage`, !CONTROLS.test(text) && text.includes("✓ tests passed") && !text.includes("payload"));
    }

    await writeFile(path, ESCAPED_TEXT);
    await act(async () => { overlay.openPager("npm test\x1b[2J", "", source, undefined, "plain"); });
    await flush();
    check(result, "live source has one initial read", reads === 1, `reads=${reads}`);
    check(result, "live source has one subscription", listeners.size === 1);
    check(result, "initial output is legible", frameCheck("initial").includes("✓ tests passed"));

    for (let round = 0; round < 3; round += 1) {
      await writeFile(path, Array.from({ length: 150 }, (_, index) =>
        `\x1b[32m✓ test-${round}-${index} passed\x1b[0m\r\n`).join(""));
      await act(async () => { updateChat(`MAIN CHAT update ${round}`); notify(); });
      await flush();
      const frame = frameCheck(`update ${round}`);
      check(result, `update ${round}: follows newly laid out bottom`, frame.includes(`✓ test-${round}-149 passed`) && frame.includes("bottom"));
    }

    for (const [width, height] of [[40, 12], [120, 30], [80, 24]] as const) {
      await act(async () => { setup.resize(width, height); });
      await flush();
      check(result, `resize ${width}x${height}: keeps the tail visible`, frameCheck(`resize ${width}x${height}`).includes("test-2-149"));
    }

    const readsBeforeBurst = reads;
    releaseRead = () => undefined;
    await act(async () => { notify(); notify(); notify(); });
    check(result, "burst notifications keep only one read in flight", reads === readsBeforeBurst + 1);
    await act(async () => { releaseRead!(); releaseRead = undefined; });
    await flush();
    check(result, "burst notifications coalesce into one trailing read", reads === readsBeforeBurst + 2);

    await act(async () => { setup.mockInput.pressArrow("up"); });
    await flush();
    check(result, "scrolling up pauses the live subscription", listeners.size === 0);
    await writeFile(path, "FINAL OUTPUT\n");
    growing = false;
    await act(async () => { notify(); });
    await flush();
    check(result, "paused view does not jump on new output", !frameCheck("paused").includes("FINAL OUTPUT"));
    await act(async () => { await setup.mockInput.pressKeys(["l"]); });
    await flush();
    const finishedFrame = frameCheck("finished");
    check(result, "resuming follows final completed output", finishedFrame.includes("FINAL OUTPUT"), finishedFrame.includes("FINAL OUTPUT") ? undefined : finishedFrame);

    releaseRead = () => undefined;
    await act(async () => { notify(); });
    await act(async () => { await setup.mockInput.pressKeys(["q"]); });
    check(result, "closing unsubscribes with a read in flight", listeners.size === 0);
    await act(async () => { releaseRead!(); releaseRead = undefined; });
    await flush();
    check(result, "late read cannot reopen or overwrite the chat", setup.captureCharFrame().includes("MAIN CHAT update 2") && !setup.captureCharFrame().includes("FINAL OUTPUT"));

    await writeFile(path, "ordinary text file\nUTF-8 café and ✓ checks\nsecond line\n");
    const textArtifact = createArtifactPagerSource(path);
    const textSource = { ...textArtifact, readPage: (offset: number) => trackRead(() => textArtifact.readPage(offset)) };
    await act(async () => { overlay.openPager("output.txt", "", textSource, undefined, "plain"); });
    await flush();
    const textFrame = frameCheck("text file");
    check(result, "ordinary UTF-8 text stays legible", textFrame.includes("UTF-8 café and ✓ checks") && textFrame.includes("second line"));
  } finally {
    await act(async () => { overlay.close(); setup.renderer.destroy(); });
    await setup.renderer.idle();
    artifact.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  return result;
}
