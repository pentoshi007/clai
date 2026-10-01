import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { PASTE_BURST_SETTLE_MS } from "../../src/ui-core/input/paste-burst.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import { installPasteBurstGuard } from "../../src/tui-v2/input/paste-burst-guard.js";

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
