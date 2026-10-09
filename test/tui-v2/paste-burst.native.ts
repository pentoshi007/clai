import assert from "node:assert/strict";
import { act, createElement } from "react";
import { EditBuffer, TextareaRenderable, type KeyEvent, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { PASTE_BURST_SETTLE_MS } from "../../src/ui-core/input/paste-burst.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import { installPasteBurstGuard } from "../../src/tui-v2/input/paste-burst-guard.js";
import { composerActionPort } from "../../src/ui-core/composer/composer-action-port.js";
import { PasteRegistry } from "../../src/ui-core/composer/paste-placeholder.js";
import { expandComposerPaste, retainComposerText } from "../../src/tui-v2/composer/expand-paste.js";
import stringWidth from "string-width";

const sent: string[] = [];
const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  persistence: {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  },
  capabilities: detectCapabilities({
    env: { COLORTERM: "truecolor" },
    stdoutIsTTY: true,
    stdinIsTTY: true,
    columns: 100,
    rows: 30,
  }),
});
attachCommandHandlers(services);
const session = services.session as unknown as {
  submit(prompt: string): Promise<void>;
  enqueue(prompt: string): void;
};
session.submit = async (prompt) => {
  sent.push(prompt);
};
session.enqueue = (prompt) => {
  sent.push(prompt);
};

const setup = await testRender(
  createElement(ServicesProvider, { services, children: createElement(App) }),
  { width: 100, height: 30, kittyKeyboard: false, useThread: false },
);
const disposeGuard = installPasteBurstGuard<KeyEvent>(setup.renderer.keyInput);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (action: () => unknown = () => undefined): Promise<void> => {
  await act(async () => {
    await action();
  });
  await act(async () => {
    await setup.flush();
  });
};
const deliver = (text: string): Promise<void> =>
  settle(() => setup.renderer.stdin.emit("data", Buffer.from(text)));
const settlePaste = async (): Promise<void> => {
  await sleep(PASTE_BURST_SETTLE_MS + 120);
  await settle();
};
const submitDraft = async (): Promise<string[]> => {
  sent.length = 0;
  await settle(() => setup.mockInput.pressEnter());
  return [...sent];
};
const composerLines = (): string[] =>
  setup
    .captureCharFrame()
    .split("\n")
    .filter((line) => line.includes("┃"))
    .map((line) => line.replace(/[┃❯]/g, "").trim())
    .filter((line) => line.length > 0);

function composerEditor(): TextareaRenderable {
  const pending: Renderable[] = [setup.renderer.root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node instanceof TextareaRenderable) return node;
    pending.push(...node.getChildren());
  }
  throw new Error("Composer textarea is missing");
}

try {
  await settle();

  sent.length = 0;
  await deliver("m1\rm2\r\rm3");
  await settlePaste();
  assert.deepEqual(sent, [], "a multi-line read must not submit anything");
  assert.deepEqual(composerLines().slice(0, 3), ["m1", "m2", "m3"]);
  assert.deepEqual(await submitDraft(), ["m1\nm2\n\nm3"], "a deliberate Enter sends the whole draft");

  sent.length = 0;
  for (const piece of ["n1\r", "\r", "n2\r", "n3"]) {
    await deliver(piece);
    await sleep(80);
  }
  await settlePaste();
  assert.deepEqual(sent, [], "lines trickling in 80 ms apart must not submit anything");
  assert.deepEqual(await submitDraft(), ["n1\n\nn2\nn3"]);

  sent.length = 0;
  for (const piece of ["p1 line", "\r", "\rp2", "\rp3"]) {
    await deliver(piece);
    await sleep(80);
  }
  await settlePaste();
  assert.deepEqual(sent, [], "Enters arriving ahead of their line must not submit anything");
  assert.deepEqual(await submitDraft(), ["p1 line\n\np2\np3"]);

  sent.length = 0;
  await deliver("hello");
  await sleep(400);
  await deliver("\r");
  await sleep(40);
  await settle();
  assert.deepEqual(sent, ["hello"], "typed text confirmed with Enter is sent promptly");

  sent.length = 0;
  await deliver("h");
  await sleep(120);
  await deliver("i");
  await sleep(120);
  await deliver("\r");
  await sleep(40);
  await settle();
  assert.deepEqual(sent, ["hi"], "keystrokes typed apart are never mistaken for a paste");

  await settle(() => setup.mockInput.pasteBracketedText("l1\rl2\r\rl3"));
  assert.deepEqual(await submitDraft(), ["l1\nl2\n\nl3"], "a bracketed paste with CR newlines keeps its lines");

  await settle(() =>
    setup.mockInput.pasteBracketedText(`${"x".repeat(60)}\r${"y".repeat(60)}\r${"z".repeat(900)}`),
  );
  const large = await submitDraft();
  assert.equal(large.length, 1);
  assert.deepEqual(large[0]?.split("\n").map((line) => line.length), [60, 60, 900]);
  assert.equal(/\r/.test(large[0] ?? ""), false);

  const transcript = Array.from({ length: 180 }, (_, i) =>
    `tool ${i}\n${JSON.stringify({ text: "Notion notes 世界 ".repeat(20), path: `/tmp/clai/session/temp/${i}-mcp.notion.notion-fetch.txt` })}\n`,
  ).join("").trimEnd();
  const pastedAt = performance.now();
  await deliver(`\u001b[200~${transcript}\u001b[201~`);
  const transcriptMs = performance.now() - pastedAt;
  assert.ok(transcriptMs < 2000, "a transcript paste must leave the UI responsive");
  const pasteFrame = setup.captureCharFrame().split("\n");
  const badgeRow = pasteFrame.findIndex((line) => /\d+ lines pasted/.test(line));
  assert.ok(badgeRow >= 0 && pasteFrame[badgeRow]?.includes("┃"), "the paste count belongs inside the composer");
  await settle(() => setup.mockMouse.moveTo(pasteFrame[badgeRow]!.indexOf("[") + 2, badgeRow));
  const hoverFrame = setup.captureCharFrame().split("\n");
  const hint = hoverFrame.find((line) => line.includes("double-click to expand"));
  assert.ok(hint?.includes("┃"), "the hover preview belongs inside the composer too");
  const hoverPoint = [pasteFrame[badgeRow]!.indexOf("[") + 2, badgeRow] as const;
  for (let index = 0; index < 6; index += 1) {
    await settle(() => setup.mockMouse.moveTo(hoverPoint[0] + index % 2, hoverPoint[1]));
    await sleep(40);
    await settle();
    assert.ok(setup.captureCharFrame().includes("double-click to expand"), "pointer movement and layout rechecks must keep the preview open");
  }
  const hintRow = hoverFrame.findIndex((line) => line.includes("double-click to expand"));
  await settle(() => setup.mockMouse.moveTo(8, hintRow));
  assert.ok(setup.captureCharFrame().includes("double-click to expand"), "moving into the preview must not dismiss it");
  await settle(() => setup.mockMouse.moveTo(0, 0));
  assert.ok(!setup.captureCharFrame().includes("double-click to expand"), "leaving the composer dismisses the preview");
  const badgePoint = (): [number, number] => {
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => /\d+ lines pasted/.test(line));
    const line = lines[y]!;
    return [stringWidth(line.slice(0, line.indexOf("["))) + 2, y];
  };
  await settle(() => setup.mockMouse.click(...badgePoint()));
  await settle(() => setup.mockMouse.click(...badgePoint()));
  assert.ok(!setup.captureCharFrame().includes("lines pasted"), "double-click expands the inline placeholder");
  await deliver("\u001b[27;5;45~");
  assert.ok(setup.captureCharFrame().includes("lines pasted"), "expansion can be undone without losing the paste");
  await settle(() => setup.mockMouse.moveTo(0, 0));
  assert.deepEqual(await submitDraft(), [transcript], "submission must preserve the entire transcript");

  const before = "漢字 👩🏽‍💻 é ";
  const firstBlock = `first line\n${"first paste ".repeat(100)}`;
  const secondBlock = `second line\n${"second paste ".repeat(100)}`;
  const after = " after 👩🏽‍💻 é";
  const editor = composerEditor();
  await settle(() => editor.insertText(before));
  await deliver(`\u001b[200~${firstBlock}\u001b[201~`);
  await settle(() => editor.insertText(" between "));
  await deliver(`\u001b[200~${secondBlock}\u001b[201~`);
  await settle(() => editor.insertText(after));
  const collapsed = editor.plainText;
  const tokens = collapsed.match(/\[\d+ lines pasted #\d+\]/g)!;
  await deliver("\u001be");
  assert.equal(editor.plainText, `${before}${tokens[0]} between ${secondBlock}${after}`, "Alt+E expands only the nearest block");
  await settle(() => editor.insertText("!"));
  assert.ok(editor.plainText.endsWith(`${after}!`), "expansion preserves the cursor after Unicode text");
  await deliver("\u001b[27;5;45~");
  await deliver("\u001b[27;5;45~");
  assert.equal(editor.plainText, collapsed, "undo restores the folded paste and surrounding text");
  await settle(() => editor.gotoBufferHome());
  await deliver("\u001be");
  assert.equal(editor.plainText, `${before}${firstBlock} between ${tokens[1]}${after}`, "moving the cursor changes which paste is expanded");
  await settle(() => editor.insertText("start "));
  assert.ok(editor.plainText.startsWith(`start ${before}`), "a cursor before the expanded paste stays in place");
  assert.deepEqual(await submitDraft(), [`start ${before}${firstBlock} between ${secondBlock}${after}`], "keyboard expansion preserves every pasted character on submission");

  for (const widthMethod of ["unicode", "wcwidth"] as const) {
    const registry = new PasteRegistry();
    const left = registry.register("left pasted content");
    const right = registry.register("right pasted content");
    const largePrefix = `${left.token} ${`${"a".repeat(1024)}\n`.repeat(1050)} `;
    const unicodeTail = " after\t漢字 👩🏽‍💻 é";
    const buffer = EditBuffer.create(widthMethod);
    try {
      buffer.setText(`${largePrefix}${right.token}${unicodeTail}`);
      buffer.setCursor(buffer.getLineCount() - 1, 60_000);
      const nativeEditor = {
        editBuffer: buffer,
        get plainText() { return buffer.getText(); },
        get cursorOffset() { return buffer.getCursorPosition().offset; },
        replaceText(text: string) { buffer.replaceText(text); },
        setCursor(row: number, col: number) { buffer.setCursor(row, col); },
      } as unknown as TextareaRenderable;
      const restore = retainComposerText(nativeEditor);
      assert.ok(expandComposerPaste(nativeEditor, registry, widthMethod));
      assert.ok(buffer.getText() === `${largePrefix}${right.text}${unicodeTail}`, "nearest-paste selection works beyond the native convenience API's 1 MB range limit");
      buffer.insertText("!");
      assert.ok(buffer.getText() === `${largePrefix}${right.text}${unicodeTail}!`, `cursor restoration follows ${widthMethod} emoji and tab widths`);
      restore();
    } finally {
      buffer.destroy();
    }
  }

  const expandedTranscript = `${"full pasted text 漢字 ".repeat(80)}\n`.repeat(800).trimEnd();
  assert.ok(Buffer.byteLength(expandedTranscript) > 1024 * 1024);
  await deliver(`\u001b[200~${expandedTranscript}\u001b[201~`);
  await deliver("\u001be");
  assert.ok(composerEditor().plainText === expandedTranscript, "expanding a paste beyond 1 MB retains the entire editable draft");
  const expandedSent = await submitDraft();
  assert.ok(expandedSent.length === 1 && expandedSent[0] === expandedTranscript, "submitting an expanded paste beyond 1 MB retains every character");

  const singleLine = `${"長いJSON transcript ".repeat(4000)}end`;
  const singleAt = performance.now();
  await deliver(singleLine);
  await settlePaste();
  const singleMs = performance.now() - singleAt;
  assert.ok(singleMs < 2000, "a large unbracketed single line must be handled as one paste");
  assert.deepEqual(await submitDraft(), [singleLine]);

  const bytes = Buffer.from(`\u001b[200~${transcript}\u001b[201~`);
  for (let start = 0; start < bytes.length; start += 5003) {
    await settle(() => setup.renderer.stdin.emit("data", bytes.subarray(start, start + 5003)));
  }
  assert.deepEqual(await submitDraft(), [transcript], "fragmented UTF-8 paste bytes must preserve all content");

  const prefix = Array.from({ length: 50 }, (_, i) => `漢字 👩🏽‍💻 é line ${i} `.repeat(8)).join("\n");
  await settle(() => composerActionPort.insert(prefix));
  await deliver(`\u001b[200~${transcript}\u001b[201~`);
  await settle(() => setup.mockMouse.moveTo(...badgePoint()));
  assert.ok(setup.captureCharFrame().includes("double-click to expand"), "inline hit testing follows the scrolled viewport and Unicode prefix");
  const scrolled = await submitDraft();
  assert.equal(scrolled.length, 1);
  assert.ok(scrolled[0]?.startsWith(prefix) && scrolled[0]?.endsWith(transcript));
  await settle(() => setup.mockMouse.moveTo(0, 0));

  console.log(`Large paste checks: ${transcript.length} chars in ${Math.round(transcriptMs)} ms; ${singleLine.length} unbracketed chars in ${Math.round(singleMs)} ms; stable hover, Alt+E, expansion, undo, Unicode widths, expanded drafts beyond 1 MB, and fragmented UTF-8 passed`);

  sent.length = 0;
  await deliver("one");
  await settle(() => setup.mockInput.pressEnter({ meta: true }));
  await deliver("two");
  await sleep(400);
  assert.deepEqual(sent, [], "Alt+Enter inserts a newline instead of submitting");
  assert.deepEqual(await submitDraft(), ["one\ntwo"]);

  console.log("Native paste burst passed: multi-line reads and slow line-by-line pastes stay one draft; typed Enter and bracketed pastes are unaffected");
} finally {
  disposeGuard();
  await act(async () => {
    services.dispose();
    setup.renderer.destroy();
  });
  await setup.renderer.idle();
}
