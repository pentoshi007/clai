import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createCliRenderer, TextRenderable } from "@opentui/core";
import { repaintAttachedScreen } from "../../../src/tui-v2/bootstrap/resize-repaint.js";

assert.equal(process.stdin.isTTY, true);
assert.equal(process.stdout.isTTY, true);
assert.equal(process.stderr.isTTY, true);
const statusFd = Number(process.env.CLAI_REPAINT_TEST_STATUS_FD);
assert.ok(Number.isInteger(statusFd) && statusFd > 2);

const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  consoleMode: "disabled",
  exitOnCtrlC: false,
  exitSignals: [],
  useKittyKeyboard: null,
  useMouse: true,
});
const report = (event: Record<string, unknown>): void => {
  writeSync(statusFd, `${JSON.stringify(event)}\n`);
};
let clicks = 0;
let repaints = 0;
let exit!: () => void;
const done = new Promise<void>((resolve) => { exit = resolve; });
const suspendControl = process.argv.includes("--suspend-control");

async function repaint(): Promise<void> {
  if (suspendControl) {
    renderer.suspend();
    await delay(30);
    renderer.resume();
  } else {
    assert.equal(repaintAttachedScreen({ renderer }), true);
  }
  await renderer.idle();
  report({ event: "repainted", count: ++repaints });
}

try {
  renderer.root.add(new TextRenderable(renderer, {
    content: "PTY repaint continuity",
    onMouseDown: () => report({ event: "mouse", count: ++clicks }),
  }));
  renderer.setFrameCallback(async () => { await delay(8); });
  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q") exit();
    if (key.name === "r") {
      void repaint().catch((error: unknown) => {
        report({ event: "error", message: String(error) });
        process.exitCode = 1;
        exit();
      });
    }
  });
  await renderer.idle();
  report({ event: "ready" });
  await done;
} finally {
  renderer.destroy();
  await renderer.idle();
}
