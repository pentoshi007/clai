import assert from "node:assert/strict";
import { act, createElement } from "react";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { createTextPagerSource } from "../../src/ui-core/rendering/artifact-pager-source.js";

const services = createCompositionRoot({ noHistory: true, provider: "openai", model: "offline" });
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 100, height: 32, useThread: false, useMouse: true,
});
const body = Array.from({ length: 8000 }, (_, i) => `ROW${String(i).padStart(5, "0")} 日本語`).join("\n");
const source = createTextPagerSource(body);
const first = await source.readPage(0);
const boundary = first.body.split("\n").length - 1;
let reads = 0;
const counted = { ...source, readPage(offset: number) { reads++; return source.readPage(offset); }, readAll() { throw new Error("Scrolling cannot read the entire source"); } };
async function settle(action: () => unknown): Promise<string> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame();
}
function boxFor(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable && node.scrollHeight > 100) return node;
  for (const child of node.getChildren()) {
    const found = boxFor(child);
    if (found) return found;
  }
}
function ids(frame: string): number[] {
  return Array.from(frame.matchAll(/ROW(\d{5})/g), match => Number(match[1]));
}
try {
  await settle(() => services.overlay.openPager("Large output", "", counted, undefined, "plain"));
  await settle(() => undefined);
  const box = boxFor(setup.renderer.root)!;
  const mounted = box.content.getChildren().length;
  const rss = Math.round(process.memoryUsage().rss / 1048576);
  console.log(JSON.stringify({ mounted, rssMiB: rss, boundary, reads }));
  assert.ok(mounted <= 4 * box.viewport.height + 4, `mounted ${mounted} children for ${box.viewport.height} rows`);
  assert.doesNotMatch(setup.captureCharFrame(), /page \d+\/\d+/);
  let frame = await settle(() => box.scrollTo(boundary - box.viewport.height - 3));
  for (let i = 0; i < 35 && !ids(frame).some(id => id > boundary + 2); i++) {
    const previous = ids(frame);
    frame = await settle(() => setup.mockMouse.scroll(box.viewport.x + 3, box.viewport.y + 2, "down"));
    const next = ids(frame);
    assert.ok(next[0]! >= previous[0]! && next[0]! <= previous.at(-1)! + 1, `${previous} => ${next}`);
  }
  assert.ok(ids(frame).some(id => id > boundary + 2), `wheel stopped at ${ids(frame)}`);
  await settle(() => setup.mockInput.pressKey("\x1b[F"));
  assert.match(await settle(() => undefined), /ROW07999/);
  await settle(() => setup.mockInput.pressKey("\x1b[H"));
  assert.match(await settle(() => undefined), /ROW00000/);
  assert.ok(reads < 20, `${reads} reads`);
  await settle(() => services.overlay.close());
  const small = createTextPagerSource(body.split("\n").slice(0, 600).join("\n"), "many chunks", 1024);
  frame = await settle(() => services.overlay.openPager("Window shifts", "", small, undefined, "plain"));
  for (const down of [true, false]) {
    const visited = new Set(ids(frame));
    for (let n = 0; n < 80 && !visited.has(down ? 599 : 0); n++) {
      frame = await settle(() => setup.mockInput.pressKey(down ? "\x1b[6~" : "\x1b[5~"));
      for (const id of ids(frame)) visited.add(id);
    }
    assert.equal(visited.size, 600, `Missing ${Array.from({ length: 600 }, (_, i) => i).filter(i => !visited.has(i)).join(",")}`);
  }
  console.log("Native continuous artifact passed");
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
