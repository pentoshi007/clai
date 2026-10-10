import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { RGBA, Renderable, ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { SubagentManager } from "../../src/agent/subagents/manager.js";
import type { SubagentWorkerInput } from "../../src/agent/subagents/types.js";
import { FileSubagentStore } from "../../src/store/subagents.js";
import { createSubagentPagerSource, formatSubagentRun } from "../../src/ui-core/rendering/subagent-source.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import { themeFor, type Theme } from "../../src/ui-core/rendering/theme.js";
import { formatFsReadSection } from "../../src/tools/fs/read-sections.js";

const directory = await mkdtemp(join(tmpdir(), "clai-subagent-continuous-"));
const store = new FileSubagentStore(directory);
const report = "Status: complete\n## Findings\nThe complete saved investigation remains available.\n## Evidence\ndocs/section-0.md:1 and the saved activity cover every inspected section.\n## Next steps\nNo further research.\n## Coverage gaps\nNone.\nLAST-REPORT-END";
const command = `inspect ${"--document=source/section.md ".repeat(7)}WRAPPED-COMMAND-END --full-evidence`;
const writer = new SubagentManager("continuous-parent", {
  store,
  async worker({ emit }) {
    for (let index = 0; index < 1200; index += 1) {
      const marker = index === 0 ? "ACROSS-TRANSCRIPT EARLY" : index === 1199 ? "ACROSS-TRANSCRIPT LATE" : `RESEARCH-ROW-${String(index).padStart(4, "0")}`;
      emit({ kind: "assistant", text: `${marker} ${"Verified evidence with a source location. ".repeat(2)}` });
      if (index % 200 === 0) {
        emit({ kind: "tool", text: `Calling fs.read: ${JSON.stringify({ path: `docs/section-${index}.md`, offset: index + 1, limit: 80 })}` });
        emit({ kind: "tool", text: "Success: PRIVATE_TOOL_BODY_MUST_NOT_APPEAR\n[Output truncated; narrow the query or page the file. Coverage is incomplete.]" });
      }
      if (index === 0) {
        emit({ kind: "tool", text: `Calling shell.exec: ${JSON.stringify({ command })}` });
        emit({ kind: "tool", text: "Success: PRIVATE_TOOL_BODY_MUST_NOT_APPEAR" });
        emit({ kind: "assistant", text: `TAB-EVIDENCE-START\n${"\t".repeat(20)}TABTAIL-PRESERVED` });
      }
    }
    return report;
  },
});
let reader: SubagentManager | undefined;
try {
  const started = writer.start({ title: "Complete persisted inspection", prompt: "Inspect every documentation section", cwd: process.cwd(), provider: "openai", model: "test" });
  const completed = await writer.wait(started.id, 10_000);
  assert.equal(completed.status, "completed", completed.error);
  assert.ok(!completed.events.some((event) => event.text.includes("ACROSS-TRANSCRIPT EARLY")), "fixture must exceed the retained event window");
  assert.ok(store.activityPath(writer.parentSessionId, started.id), "fixture must persist the activity journal");
  writer.dispose();
  reader = new SubagentManager("continuous-parent", { store });

  for (const width of [120, 80]) {
    const copied: string[] = [];
    const services = createCompositionRoot({
      noHistory: true,
      clipboard: { async writeText(text) { copied.push(text); }, async readText() { return ""; } },
      persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
      capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 35 }),
    });
    const source = createSubagentPagerSource(reader, started.id);
    const entireBody = await source.readAll();
    assert.ok(Buffer.byteLength(entireBody) > 64 * 1024, "fixture must exceed the former byte page boundary");
    assert.ok(entireBody.includes("ACROSS-TRANSCRIPT EARLY"), "early saved history must remain available");
    assert.ok(entireBody.includes("ACROSS-TRANSCRIPT LATE"), "late saved history must remain available");
    assert.ok(/✓ fs\.read docs\/section-0\.md/.test(entireBody), "saved calls must use semantic tool formatting");
    assert.ok(entireBody.includes(`${"\t".repeat(20)}TABTAIL-PRESERVED`), "source body must preserve the original tabs for copying");
    assert.ok(!/PRIVATE_TOOL_BODY_MUST_NOT_APPEAR|Calling fs\.read:|Success:|### Attempt/.test(entireBody), "saved evidence bodies and protocol must remain collapsed");
    assert.ok((await source.readPage(0)).body === entireBody, "continuous reads must expose the complete body");
    const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
      width, height: 35, kittyKeyboard: true, useMouse: true, useThread: false,
    });
    const settle = async (action: () => unknown = () => undefined): Promise<string> => {
      await act(async () => { await action(); await new Promise<void>((resolve) => setTimeout(resolve, 10)); });
      await act(async () => { await setup.flush(); });
      return setup.captureCharFrame();
    };
    const waitFor = async (pattern: RegExp, action: () => unknown = () => undefined): Promise<string> => {
      let frame = await settle(action);
      for (let attempt = 0; attempt < 100 && !pattern.test(frame); attempt += 1) {
        frame = await settle();
      }
      if (!pattern.test(frame)) {
        const pending: Renderable[] = [setup.renderer.root];
        const boxes: Array<Record<string, unknown>> = [];
        while (pending.length) {
          const node = pending.pop()!;
          if (node instanceof ScrollBoxRenderable) boxes.push({
            id: node.id, top: node.scrollTop, scrollHeight: node.scrollHeight,
            viewportHeight: node.viewport.height, viewportWidth: node.viewport.width,
            contentHeight: node.content.height, children: node.content.getChildren().length,
          });
          pending.push(...node.getChildren());
        }
        console.error(JSON.stringify({ pattern: pattern.source, width, boxes }));
      }
      assert.match(frame, pattern);
      return frame;
    };
    const scrollBox = (): ScrollBoxRenderable => {
      const pending: Renderable[] = [setup.renderer.root];
      while (pending.length) {
        const node = pending.pop()!;
        if (node instanceof ScrollBoxRenderable && node.scrollHeight > 1000) return node;
        pending.push(...node.getChildren());
      }
      throw new Error("The continuous transcript scrollbox was not mounted");
    };
    const countNodes = (node: Renderable): number => 1 + node.getChildren().reduce((sum, child) => sum + countNodes(child), 0);
    const assertVirtualized = (): void => {
      const box = scrollBox();
      const mounted = box.content.getChildren().reduce((sum, child) => sum + countNodes(child), 0);
      assert.ok(mounted < 8 * box.viewport.height + 80, `${mounted} native nodes mounted for ${box.viewport.height} visible rows`);
    };
    const assertColor = (text: string, token: keyof Theme): void => {
      const expected = RGBA.fromHex(themeFor(services.capabilities.themeHint)[token]);
      const colored = setup.captureSpans().lines.map((line) =>
        line.spans.filter((span) => span.fg.equals(expected)).map((span) => span.text).join("").trim(),
      ).join("");
      assert.ok(colored.includes(text), `${text} must use ${token} at ${width} columns: ${setup.captureCharFrame()}`);
    };
    try {
      const frame = await waitFor(/WRAPPED-COMMAND-END/, () => services.overlay.openPager("Complete persisted inspection", formatSubagentRun(reader!.get(started.id)!), source, undefined, "plain"));
      assert.match(frame, /ACROSS-TRANSCRIPT EARLY/);
      assert.doesNotMatch(frame, /page \d+\/\d+/);
      assert.match(frame, /✓ fs\.read docs\/section-0\.md/);
      assert.match(frame, /WRAPPED-COMMAND-END/);
      assertColor("shell.exec", "cyan");
      assertColor("WRAPPED-COMMAND-END", "muted");
      assertVirtualized();
      const formatted = await waitFor(/WRAPPED-COMMAND-END/, () => setup.mockInput.pressKey("f"));
      assert.match(formatted, /ACROSS-TRANSCRIPT EARLY/);
      assert.doesNotMatch(formatted, /page \d+\/\d+/);
      assertColor("shell.exec", "cyan");
      assertColor("WRAPPED-COMMAND-END", "muted");
      assertVirtualized();
      await waitFor(/WRAPPED-COMMAND-END/, () => setup.mockInput.pressKey("r"));
      await settle(() => setup.mockInput.pressKey("r", { ctrl: true }));
      await settle(() => setup.mockInput.typeText("TABTAIL-PRESERVED"));
      await waitFor(/TABTAIL-PRESERVED/, () => setup.mockInput.pressEnter());
      assertVirtualized();
      await settle(() => setup.mockInput.pressKey("q"));
      await waitFor(/ACROSS-TRANSCRIPT EARLY/, () => setup.mockInput.pressKey("\x1b[H"));
      const firstTop = scrollBox().scrollTop;
      await settle(() => setup.mockInput.pressArrow("down"));
      assert.ok(scrollBox().scrollTop > firstTop, "Down must scroll through the transcript");
      await settle(() => setup.mockInput.pressArrow("up"));
      assert.equal(scrollBox().scrollTop, firstTop);
      await settle(() => setup.mockInput.pressKey("\x1b[6~"));
      assert.ok(scrollBox().scrollTop >= scrollBox().viewport.height - 2, "PageDown must advance one viewport");
      assertVirtualized();
      await waitFor(/LAST-REPORT-END/, () => setup.mockInput.pressKey("\x1b[F"));
      assert.ok(scrollBox().scrollTop > 1000, "End must reach content after the former page boundary");
      assertVirtualized();
      await waitFor(/ACROSS-TRANSCRIPT EARLY/, () => setup.mockInput.pressKey("\x1b[H"));
      assert.equal(scrollBox().scrollTop, 0);
      await settle(() => setup.mockInput.pressKey("r", { ctrl: true }));
      await settle(() => setup.mockInput.typeText("ACROSS-TRANSCRIPT"));
      await waitFor(/ACROSS-TRANSCRIPT EARLY/, () => setup.mockInput.pressEnter());
      await waitFor(/ACROSS-TRANSCRIPT LATE/, () => setup.mockInput.pressKey("n"));
      assertVirtualized();
      await waitFor(/ACROSS-TRANSCRIPT EARLY/, () => setup.mockInput.pressKey("n", { shift: true }));
      await waitFor(/copied all/, () => setup.mockInput.pressKey("c"));
      assert.ok(copied.at(-1) === entireBody, "copy must include the complete saved transcript");
      await settle(() => setup.mockInput.pressKey("q"));
      assert.equal(services.overlay.getState().kind, "pager", "first close must clear the active search");
      await settle(() => setup.mockInput.pressKey("q"));
      assert.equal(services.overlay.getState().kind, "none");
      assert.equal(services.focus.activeContext(), "composer");
      if (width === 120) {
        let liveWorker: SubagentWorkerInput | undefined;
        const liveManager = new SubagentManager("live-continuous-parent", {
          store,
          worker(input) {
            liveWorker = input;
            for (let index = 0; index < 1200; index += 1) {
              const marker = index === 0 ? "LIVE-FIRST" : index === 1199 ? "LIVE-LAST" : `LIVE-ROW-${index}`;
              input.emit({ kind: "assistant", text: `${marker} ${"Evidence remains available while the agent continues. ".repeat(2)}` });
            }
            return new Promise<string>((resolve) => input.signal.addEventListener("abort", () => resolve(report), { once: true }));
          },
        });
        let liveSource: ReturnType<typeof createSubagentPagerSource> | undefined;
        try {
          const liveRun = liveManager.start({ title: "Live continuous inspection", prompt: "Keep investigating", cwd: process.cwd(), provider: "openai", model: "test" });
          await settle(() => new Promise<void>((resolve) => setTimeout(resolve, 450)));
          assert.ok(liveWorker);
          liveSource = createSubagentPagerSource(liveManager, liveRun.id);
          assert.ok(Buffer.byteLength(await liveSource.readAll()) > 64 * 1024);
          await waitFor(/LIVE-LAST/, () => services.overlay.openPager("Live continuous inspection", formatSubagentRun(liveManager.get(liveRun.id)!), liveSource, undefined, "plain"));
          assert.ok(scrollBox().scrollTop > 1000, "a live transcript must initially follow its complete tail");
          assertVirtualized();
          await waitFor(/LIVE-FIRST/, () => setup.mockInput.pressKey("\x1b[H"));
          const pausedTop = scrollBox().scrollTop;
          await settle(() => liveWorker!.emit({ kind: "assistant", text: "LIVE-APPENDED-WHILE-PAUSED" }));
          await settle(() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
          assert.ok((await liveSource.readAll()).includes("LIVE-APPENDED-WHILE-PAUSED"));
          assert.equal(scrollBox().scrollTop, pausedTop, "new live evidence must preserve the paused reading position");
          assert.doesNotMatch(await settle(), /LIVE-APPENDED-WHILE-PAUSED/);
          await waitFor(/LIVE-APPENDED-WHILE-PAUSED/, () => setup.mockInput.pressKey("l"));
          assertVirtualized();
          await waitFor(/LIVE-FOLLOWED-UPDATE/, () => liveWorker!.emit({ kind: "assistant", text: "LIVE-FOLLOWED-UPDATE" }));
          assert.ok(scrollBox().scrollTop > 1000);
          const multilineCommand = [
            "printf '%s\\n' '**literal** `argument` <br> # heading | column';",
            `\tWRAP-INPUT-START ${"docs/日本語-🔬/".repeat(8)}WRAP-INPUT-END`,
            "printf DONE-INPUT-END",
            "12 │ **gutter**",
          ].join("\r\n");
          const readFiles = [
            { path: `docs/${"long-section/".repeat(9)}FIRST-READ.md`, offset: 12, limit: 80 },
            { path: `docs/${"another-section/".repeat(8)}SECOND-READ.md`, offset: 200, limit: 60 },
          ];
          const assertNoToolGaps = (frame: string, first: string, last: string): void => {
            const rows = frame.split("\n");
            const start = rows.findIndex((row) => row.includes(first));
            const end = rows.findIndex((row) => row.includes(last));
            assert.ok(start >= 0 && end > start, `tool range ${first} to ${last} must remain visible`);
            for (const row of rows.slice(start, end + 1)) {
              assert.ok(row.replace(/[│┃]/g, "").trim().length > 0, `unexpected blank tool row: ${frame}`);
            }
            const box = scrollBox();
            for (const row of box.content.getChildren().slice(1, -1)) {
              assert.equal(row.height, 1, "wrapped transcript rows must occupy one terminal row");
            }
          };
          for (const toolWidth of [120, 80]) {
            await settle(() => setup.resize(toolWidth, 35));
            await settle(() => setup.mockInput.pressKey("r"));
            await settle(() => setup.mockInput.pressKey("\x1b[F"));
            const pendingCommand = await waitFor(/→ shell\.exec/, () => {
              liveWorker!.emit({ kind: "assistant", text: "LIVE-TOOL-START" });
              liveWorker!.emit({ kind: "tool", text: `Calling shell.exec: ${JSON.stringify({ command: multilineCommand, cwd: "/workspace" })}` });
            });
            assert.match(pendingCommand, /→ shell\.exec/);
            assert.match(pendingCommand, /In progress/);
            assertNoToolGaps(pendingCommand, "LIVE-TOOL-START", "In progress");
            assertColor("shell.exec", "cyan");
            assertColor("**literal**", "muted");
            assertColor("WRAP-INPUT-END", "muted");
            await settle(() => setup.mockInput.pressKey("f"));
            const formattedCommand = await waitFor(/DONE-INPUT-END/, () => setup.mockInput.pressKey("\x1b[F"));
            assert.match(formattedCommand, /→ shell\.exec/);
            assert.match(formattedCommand, /\*\*literal\*\* `argument` <br> # heading/);
            assert.match(formattedCommand, /12 │ \*\*gutter\*\*/);
            assertNoToolGaps(formattedCommand, "LIVE-TOOL-START", "In progress");
            assertColor("**literal**", "muted");
            assertColor("WRAP-INPUT-END", "muted");
            assertColor("**gutter**", "muted");
            const completedCommand = await waitFor(/^(?![\s\S]*In progress)[\s\S]*✓ shell\.exec/, () => liveWorker!.emit({ kind: "tool", text: "Success: PRIVATE_LIVE_TOOL_BODY" }));
            assert.match(completedCommand, /DONE-INPUT-END/);
            assert.doesNotMatch(completedCommand, /In progress|PRIVATE_LIVE_TOOL_BODY/);
            assertNoToolGaps(completedCommand, "LIVE-TOOL-START", "DONE-INPUT-END");
            const pendingRead = await waitFor(/→ fs\.read/, () => liveWorker!.emit({ kind: "tool", text: `Calling fs.read: ${JSON.stringify({ files: readFiles })}` }));
            assert.match(pendingRead, /→ fs\.read/);
            assertNoToolGaps(pendingRead, "→ fs.read", "In progress");
            assertColor("fs.read", "cyan");
            assertColor("FIRST-READ.md", "muted");
            assertColor("SECOND-READ.md", "muted");
            const completedRead = await waitFor(/^(?![\s\S]*In progress)[\s\S]*✓ fs\.read/, () => liveWorker!.emit({ kind: "tool", text: `Success: ${readFiles.map((file, index) => formatFsReadSection({ index: index + 1, total: 2, path: file.path, ok: true, body: "PRIVATE_LIVE_TOOL_BODY" })).join("\n\n")}` }));
            assert.match(completedRead, /file 1\/2: ✓/);
            assert.match(completedRead, /file 2\/2: ✓/);
            assert.doesNotMatch(completedRead, /In progress|PRIVATE_LIVE_TOOL_BODY/);
            assertNoToolGaps(completedRead, "✓ fs.read", "SECOND-READ.md");
            await settle(() => setup.mockInput.pressKey("r"));
            const rawRead = await waitFor(/SECOND-READ\.md/, () => setup.mockInput.pressKey("\x1b[F"));
            assert.match(rawRead, /✓ fs\.read/);
            assertNoToolGaps(rawRead, "✓ fs.read", "SECOND-READ.md");
            assertColor("FIRST-READ.md", "muted");
            assertColor("SECOND-READ.md", "muted");
            assertVirtualized();
          }
          await waitFor(/LIVE-FOLLOWED-UPDATE/, () => liveWorker!.emit({ kind: "assistant", text: "LIVE-FOLLOWED-UPDATE" }));
          await settle(() => setup.mockInput.pressKey("\x1b[5~"));
          const tallViewport = scrollBox().viewport.height;
          await waitFor(/LIVE-ROW-/, () => setup.resize(80, 14));
          assert.ok(scrollBox().viewport.height < tallViewport, "resize must update the native pager viewport");
          assertVirtualized();
          await waitFor(/LIVE-ROW-/, () => setup.resize(width, 35));
          assertVirtualized();
          await waitFor(/LIVE-FIRST/, () => setup.mockInput.pressKey("\x1b[H"));
          await waitFor(/LIVE-FOLLOWED-UPDATE/, () => setup.mockInput.pressKey("l"));
          await settle(() => setup.mockInput.pressKey("q"));
          assert.equal(services.overlay.getState().kind, "none");
        } finally {
          liveSource?.dispose();
          liveManager.dispose();
        }
      }
    } finally {
      await act(async () => { source.dispose(); services.dispose(); setup.renderer.destroy(); });
      await setup.renderer.idle();
    }
  }
  console.log("Native continuous subagent passed: saved history, virtualized mounting, arrows, PageDown, Home, End, search and complete copy at 80/120 columns");
} finally {
  writer.dispose();
  reader?.dispose();
  await rm(directory, { recursive: true, force: true });
}
