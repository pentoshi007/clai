import assert from "node:assert/strict";
import { act, createElement } from "react";
import { TextareaRenderable, type KeyEvent, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { CommandInvocation } from "../../src/app/commands/command.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import { installPasteBurstGuard } from "../../src/tui-v2/input/paste-burst-guard.js";
import { setComposerCharacterOffset } from "../../src/tui-v2/composer/composer-cursor.js";

const commands: CommandInvocation[] = [];
const prompts: string[] = [];
const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  persistence: {
    async saveSession() {},
    async loadPlan() { return undefined; },
    async savePlan() {},
    async deletePlan() {},
  },
  capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 30 }),
});
for (const definition of services.commands.all()) {
  services.commands.setHandler(definition.name, (invocation) => { commands.push(invocation); });
}
const session = services.session as unknown as { submit(prompt: string): Promise<void>; enqueue(prompt: string): void };
session.submit = async (prompt) => { prompts.push(prompt); };
session.enqueue = (prompt) => { prompts.push(prompt); };
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 100, height: 30, kittyKeyboard: false, useThread: false,
});
const disposeGuard = installPasteBurstGuard<KeyEvent>(setup.renderer.keyInput);
const settle = async (action: () => unknown = () => undefined): Promise<void> => {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
};
const deliver = (text: string): Promise<void> => settle(() => setup.renderer.stdin.emit("data", Buffer.from(text)));
const paste = (text: string): Promise<void> => deliver(`\u001b[200~${text}\u001b[201~`);
const enter = (): Promise<void> => settle(() => setup.mockInput.pressEnter());
function editor(): TextareaRenderable {
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
  const prefix = "Unicode 👩🏽‍💻 👩🏽‍💻 👩🏽‍💻 é draft ";
  await paste(prefix);
  await deliver("/");
  assert.ok(setup.captureCharFrame().includes("commands ·"), "a slash after Unicode text opens the command menu");
  await deliver("he");
  await deliver("\t\r");
  await settle();
  assert.equal(commands.at(-1)?.name, "help", "Tab followed immediately by Enter runs the inline command");
  assert.equal(editor().plainText, prefix, "inline commands preserve the Unicode draft");
  assert.deepEqual(prompts, [], "commands must not reach the model");
  await deliver("\u0011");

  await paste("/model custom-model");
  await settle(() => editor().setCursor(0, 3));
  await enter();
  assert.equal(commands.at(-1)?.name, "model");
  assert.equal(commands.at(-1)?.args, "custom-model", "the command keeps its arguments when the cursor is in its name");
  assert.equal(editor().plainText, "");

  const argument = "pasted model details ".repeat(100).trimEnd();
  await paste("/model ");
  await paste(argument);
  await settle(() => editor().setCursor(0, 3));
  await enter();
  assert.equal(commands.at(-1)?.args, argument, "folded paste arguments are expanded before command dispatch");

  for (const definition of services.commands.all()) {
    for (const name of [definition.name, ...(definition.aliases ?? [])]) {
      for (const args of ["", "sentinel-argument"]) {
        await paste(`  /${name}${args ? ` ${args}` : ""}`);
        await enter();
        assert.equal(commands.at(-1)?.name, definition.name, `/${name} dispatches locally`);
        assert.equal(commands.at(-1)?.args, args);
      }
    }
  }
  assert.deepEqual(prompts, [], "all registered commands and aliases stay out of model prompts");

  await paste("draft /he");
  await deliver("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await settle();
  await enter();
  assert.equal(commands.at(-1)?.name, "help", "a closed menu cannot turn a valid active command into a prompt");
  assert.equal(editor().plainText, "draft ");
  await deliver("\u0011");

  const commandCount = commands.length;
  await deliver("/help\r");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  await settle();
  assert.equal(commands.length, commandCount + 1, "a command and Enter in one terminal read execute exactly once");
  assert.equal(commands.at(-1)?.name, "help", "a full command and Enter in the same terminal read dispatch locally");
  assert.equal(editor().plainText, "");
  assert.deepEqual(prompts, []);

  const middle = `${prefix}\n${prefix}/he remaining text`;
  await paste(middle);
  await settle(() => setComposerCharacterOffset(editor(), middle, middle.indexOf("/he") + 3, setup.renderer.widthMethod));
  await deliver("\u001b[9u\u001b[13u");
  assert.equal(commands.at(-1)?.name, "help");
  assert.equal(editor().plainText, `${prefix}\n${prefix}remaining text`, "completion in a Unicode line keeps surrounding text");
  await settle(() => editor().insertText("cursor "));
  assert.equal(editor().plainText, `${prefix}\n${prefix}cursor remaining text`, "completion preserves the correct logical cursor");
  await deliver("\u0011");

  await paste("draft /he");
  await deliver("\t\r");
  await settle();
  assert.equal(commands.at(-1)?.name, "help", "legacy Tab and Enter dispatch promptly");
  assert.equal(editor().plainText, "draft ");
  await deliver("\u0011");

  await paste("/not-a-real-command");
  await enter();
  assert.deepEqual(prompts, [], "unknown leading commands report a warning locally");
  await paste("/tmp/notes.txt");
  await enter();
  await paste("explain /help usage");
  await enter();
  assert.deepEqual(prompts, ["/tmp/notes.txt", "explain /help usage"], "filesystem paths and prose remain ordinary prompts");
  console.log("Native slash commands passed: Unicode, fast Tab+Enter, dismissed menus, arguments, all commands and aliases, and literal paths");
} finally {
  disposeGuard();
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
