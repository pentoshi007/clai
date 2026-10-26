import assert from "node:assert/strict";
import { act, createElement, useState, type ComponentProps, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import { FileDiffBody } from "../../src/tui-v2/components/transcript/file-diff-card.js";
import { ToolCard } from "../../src/tui-v2/components/transcript/tool-card.js";
import { TerminalDimensionsContext } from "../../src/tui-v2/hooks/terminal-dimensions.js";
import { buildFileChange, type FileChange } from "../../src/tools/file-diff.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { buildModalPagerRows, diffCardMaxLineChars, gutterWidth, presentFileChangePreview } from "../../src/ui-core/rendering/file-diff-view.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { asToolCallId, asTurnId } from "../../src/app/events/app-event.js";
import type { ToolItem } from "../../src/ui-core/state/transcript-types.js";

const height = 160;
let scenarios = 0;

function InteractiveDiffCard(props: ComponentProps<typeof ToolCard>): ReactNode {
  const [diffExpanded, setDiffExpanded] = useState(true);
  return createElement(ToolCard, {
    ...props,
    fileDiffExpanded: diffExpanded,
    onToggleFileDiff() {
      props.onToggleFileDiff?.();
      setDiffExpanded(value => !value);
    },
  });
}

function change(lines: number, file = 0): FileChange {
  return buildFileChange({
    path: `/repo/file-${file}.ts`, before: "", kind: "create",
    after: Array.from({ length: lines }, (_, row) => `const ROW_${file}_${row} = ${row};`).join("\n"),
  });
}

async function renderBody(props: {
  changes: readonly FileChange[];
  width: number;
  cardWidth: number;
  expanded: boolean;
  multi: boolean;
  showHunks?: boolean;
}): Promise<{ frame: string; rows: number }> {
  const { changes, width, cardWidth, expanded, multi, showHunks = true } = props;
  const setup = await testRender(createElement(TerminalDimensionsContext.Provider, {
    value: { width, height },
    children: createElement("box", {
      id: "diff-card", border: true, borderStyle: "rounded",
      style: { width: cardWidth, flexDirection: "column", paddingLeft: 1, paddingRight: 1 },
      children: createElement("box", {
        id: "diff-body", style: { width: "100%", flexDirection: "column" },
        children: createElement(FileDiffBody, {
          changes, theme: themeFor(width === 40 || width === 120 ? "light" : "dark"),
          diffExpanded: showHunks, outputExpanded: expanded, multiFilePreview: multi,
          contentWidth: cardWidth, onOpen() {},
        }),
      }),
    }),
  }), { width, height, useThread: false });
  try {
    await act(async () => { await setup.flush(); });
    const frame = setup.captureCharFrame();
    const body = setup.renderer.root.findDescendantById("diff-body")!;
    const card = setup.renderer.root.findDescendantById("diff-card")!;
    assert.ok(body && card, frame);
    if (!expanded) assert.ok(body.height <= 20, `${body.height} collapsed rows\n${frame}`);
    const buffer = setup.renderer.currentRenderBuffer;
    for (let y = card.y + 1; y < card.y + card.height - 1; y += 1) {
      const at = (x: number) => buffer.buffers.char[y * buffer.width + x];
      assert.equal(at(card.x), "│".codePointAt(0), frame);
      assert.equal(at(card.x + card.width - 1), "│".codePointAt(0), frame);
      assert.equal(at(card.x + card.width - 2), " ".codePointAt(0), frame);
    }
    scenarios += 1;
    return { frame, rows: body.height };
  } finally {
    await act(async () => { setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}

for (const [width, cardWidth] of [[24, 24], [40, 40], [80, 80], [120, 120], [120, 40]] as const) {
  for (const multi of [false, true]) {
    const changes = Array.from({ length: multi ? 15 : 1 }, (_, file) => change(multi ? 30 : 60, file));
    const stored = structuredClone(changes);
    for (const expanded of [false, true]) {
      const result = await renderBody({ changes, width, cardWidth, expanded, multi });
      assert.match(result.frame, /ROW_0_0/);
      if (!expanded) {
        assert.equal(result.rows, 20);
        assert.ok(!result.frame.includes("ROW_0_39"), result.frame);
        if (multi) {
          assert.equal(result.frame.match(/more files/g)?.length, 1, result.frame);
          assert.ok(!result.frame.includes("file-11.ts"), result.frame);
        }
      } else {
        const expected = changes.slice(0, multi ? 12 : changes.length).reduce((total, file) => {
          return total + Number(multi) + presentFileChangePreview(file, {
            maxRows: multi ? 8 : 40,
            maxLineChars: diffCardMaxLineChars(cardWidth, gutterWidth(file)), tabWidth: 0,
          }).length;
        }, Number(!multi) + Number(multi && changes.length > 12));
        assert.equal(result.rows, expected, result.frame);
        assert.ok(result.rows > 20, result.frame);
        if (multi) {
          assert.match(result.frame, /file-11\.ts/);
          assert.equal(result.frame.match(/more files/g)?.length, 1, result.frame);
        } else if (cardWidth >= 80) {
          assert.match(result.frame, /ROW_0_39/);
        }
      }
      assert.deepEqual(changes, stored);
    }
  }
}

for (const lines of [0, 1, 18, 19, 20, 21]) {
  const result = await renderBody({ changes: [change(lines)], width: 120, cardWidth: 120, expanded: false, multi: false });
  assert.equal(result.rows, Math.min(20, 1 + Math.max(1, lines)), result.frame);
  if (lines > 0 && lines <= 19) {
    assert.ok(result.frame.includes(`ROW_0_${lines - 1}`), result.frame);
    assert.ok(!result.frame.includes("more"), result.frame);
  }
}

const binary = await renderBody({ changes: [{ ...change(0), binary: true }], width: 80, cardWidth: 80, expanded: false, multi: false });
assert.equal(binary.rows, 2);
assert.match(binary.frame, /binary/);
const noHunks = await renderBody({ changes: Array.from({ length: 15 }, (_, file) => change(30, file)), width: 120, cardWidth: 120, expanded: false, multi: true, showHunks: false });
assert.equal(noHunks.rows, 13);
assert.match(noHunks.frame, /file-11\.ts/);
assert.match(noHunks.frame, /\+3 more files/);
assert.ok(!noHunks.frame.includes("ROW_"));

for (const multi of [false, true]) {
  const changes = Array.from({ length: multi ? 15 : 1 }, (_, file) => change(multi ? 30 : 60, file));
  const item: ToolItem = {
    id: "tool-diff", sequence: 1, turnId: asTurnId("turn-1"), timestamp: 0, kind: "tool",
    toolCallId: asToolCallId("diff-call"), name: multi ? "fs.writeMany" : "fs.write", argsDisplay: "",
    status: "ok", exitCode: 0, summary: undefined, artifactPath: undefined, reason: undefined,
    outputBytes: 0, fileChanges: changes,
  };
  const stored = structuredClone(item);
  const services = createCompositionRoot({
    noHistory: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: height }),
  });
  try {
    const sizes: number[] = [];
    for (const expanded of [false, true]) {
      let diffToggles = 0;
      let outputToggles = 0;
      const setup = await testRender(createElement(ServicesProvider, {
        services,
        children: createElement(TerminalDimensionsContext.Provider, {
          value: { width: 120, height },
          children: createElement("box", {
            style: { width: 116, flexDirection: "column" },
            children: createElement(InteractiveDiffCard, {
              item, theme: themeFor("dark"), spool: services.session.spool, expanded,
              services, onToggle() { outputToggles += 1; },
              onToggleFileDiff() { diffToggles += 1; }, contentWidth: 116,
            }),
          }),
        }),
      }), { width: 120, height, useThread: false, useMouse: true });
      try {
        await act(async () => { await setup.flush(); });
        const frame = setup.captureCharFrame();
        assert.doesNotMatch(frame, /\b(?:expand|collapse) all\b/i);
        const card = setup.renderer.root.findDescendantById(item.id)!;
        sizes.push(card.height);
        assert.equal(frame.includes(multi ? "file-11.ts" : "ROW_0_39"), expanded, frame);
        if (!expanded) assert.ok(card.height <= 30, frame);
        if (multi) assert.equal(frame.match(/more files/g)?.length, 1, frame);
        for (const label of ["collapse", "expand"]) {
          const before = setup.captureCharFrame();
          const frameRows = before.split("\n");
          const row = frameRows.findIndex(line => line.includes(label));
          assert.ok(row >= 0, before);
          const column = frameRows[row]!.indexOf(label);
          await act(async () => { await setup.mockMouse.click(column + 1, row); });
          await act(async () => { await setup.flush(); });
          const after = setup.captureCharFrame();
          assert.equal(after.includes("ROW_0_0"), label === "expand", after);
          assert.doesNotMatch(after, /\b(?:expand|collapse) all\b/i);
          assert.equal(services.overlay.getState().kind, "none", after);
        }
        assert.equal(diffToggles, 2, frame);
        assert.equal(outputToggles, 0, frame);
        assert.equal(setup.captureCharFrame(), frame);
        assert.deepEqual(item, stored);
        scenarios += 1;
      } finally {
        await act(async () => { setup.renderer.destroy(); });
        await setup.renderer.idle();
      }
    }
    assert.ok(sizes[1]! > sizes[0]!);
    assert.match(buildModalPagerRows(changes.at(-1)!).map((row) => row.body).join("\n"), multi ? /ROW_14_29/ : /ROW_0_59/);
  } finally {
    services.dispose();
  }
}

console.log(`Native diff preview passed: ${scenarios} single/multi-file, narrow-pane, boundary, binary and ToolCard expansion scenarios; collapsed bodies <=20 rows, full data and borders intact`);
