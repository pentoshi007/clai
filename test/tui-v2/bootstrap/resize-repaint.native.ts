import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { repaintAttachedScreen } from "../../../src/tui-v2/bootstrap/resize-repaint.js";

const corePackage = JSON.parse(readFileSync(
  new URL("./package.json", import.meta.resolve("@opentui/core")),
  "utf8",
));
assert.equal(corePackage.version, "0.4.5");

const chunks: string[] = [];
const rawModes: boolean[] = [];
const stdin = Object.assign(new PassThrough(), {
  setRawMode(enabled: boolean) {
    rawModes.push(enabled);
    return this;
  },
});
const stdout = Object.assign(new Writable({
  write(chunk, _encoding, callback) {
    chunks.push(chunk.toString());
    callback();
  },
}), { columns: 12, rows: 3 });
const { renderer, flush } = await createTestRenderer({
  width: 12,
  height: 3,
  stdin: stdin as NodeJS.ReadStream,
  stdout: stdout as NodeJS.WriteStream,
  bufferedOutput: "stdout",
  screenMode: "alternate-screen",
  useThread: false,
  gatherStats: true,
});

try {
  renderer.root.add(new TextRenderable(renderer, { content: "hello" }));
  await flush();
  const controlState = renderer.controlState;
  const initialRawModes = [...rawModes];
  const inputListeners = stdin.listeners("data");
  assert.deepEqual(initialRawModes, [true]);
  assert.ok(inputListeners.length > 0);
  chunks.length = 0;
  renderer.requestRender();
  await flush();
  assert.equal(chunks.join(""), "");

  for (let attempt = 0; attempt < 3; attempt++) {
    chunks.length = 0;
    assert.equal(repaintAttachedScreen({ renderer }), true);
    assert.equal(renderer.controlState, controlState);
    assert.deepEqual(rawModes, initialRawModes);
    assert.deepEqual(stdin.listeners("data"), inputListeners);
    await flush();
    const output = chunks.join("");
    assert.equal(renderer.getNativeStats().cellsUpdated, 36);
    assert.match(output, /hello {7}/);
    for (const row of [2, 3]) {
      assert.ok(output.includes(`\u001b[${row};1H\u001b[38;2;255;255;255m\u001b[49m${" ".repeat(12)}`));
    }
    for (const sequence of ["\u001b[?1049l", "\u001b[?1049h", "\u001b[H\u001b[J", "\u001b[?1006l"]) {
      assert.equal(output.includes(sequence), false);
    }

    chunks.length = 0;
    renderer.requestRender();
    await flush();
    assert.equal(chunks.join(""), "");
  }

  let startFrame!: () => void;
  let finishFrame!: () => void;
  const frameStarted = new Promise<void>((resolve) => { startFrame = resolve; });
  const frameFinished = new Promise<void>((resolve) => { finishFrame = resolve; });
  const holdFrame = async (): Promise<void> => {
    startFrame();
    await frameFinished;
  };
  renderer.setFrameCallback(holdFrame);
  chunks.length = 0;
  renderer.requestRender();
  await frameStarted;
  try {
    assert.equal(renderer.getSchedulerState().isRendering, true);
    assert.equal(repaintAttachedScreen({ renderer }), true);
    assert.equal(chunks.join(""), "");
    assert.deepEqual(rawModes, initialRawModes);
    assert.deepEqual(stdin.listeners("data"), inputListeners);
  } finally {
    renderer.removeFrameCallback(holdFrame);
    finishFrame();
  }
  await flush();
  assert.match(chunks.join(""), /hello {7}/);
  assert.equal(chunks.join("").includes("\u001b[?1049l"), false);

  for (const [width, height] of [[8, 2], [16, 4], [12, 3]] as const) {
    chunks.length = 0;
    renderer.resize(width, height);
    await flush();
    assert.equal(renderer.width, width);
    assert.equal(renderer.height, height);
    assert.match(chunks.join(""), /hello/);
    assert.equal(chunks.join("").includes("\u001b[?1049l"), false);
  }
  assert.deepEqual(rawModes, initialRawModes);
  assert.deepEqual(stdin.listeners("data"), inputListeners);
} finally {
  renderer.destroy();
  await renderer.idle();
}

assert.equal(repaintAttachedScreen({ renderer }), false);
console.log("Native repaint regressions passed");
