import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import {
  repaintAttachedScreen,
  type FullRepaintRenderer,
} from "../../src/tui-v2/bootstrap/resize-repaint.js";

const WIDTH = 100;
const HEIGHT = 30;
const ALL_CELLS = WIDTH * HEIGHT;
const F5 = "\x1b[15~";

const renderer: { current: FullRepaintRenderer | undefined } = { current: undefined };
let redrawRequests = 0;

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
    columns: WIDTH,
    rows: HEIGHT,
  }),
  requestRedraw: () => {
    redrawRequests += 1;
    return renderer.current ? repaintAttachedScreen({ renderer: renderer.current }) : false;
  },
});
attachCommandHandlers(services);

const setup = await testRender(
  createElement(ServicesProvider, { services, children: createElement(App) }),
  {
    width: WIDTH,
    height: HEIGHT,
    kittyKeyboard: true,
    useThread: false,
    gatherStats: true,
  },
);
renderer.current = setup.renderer;

const settle = async (action: () => unknown = () => undefined): Promise<void> => {
  await act(async () => {
    await action();
  });
  await act(async () => {
    await setup.flush();
  });
};

const cellsRewrittenBy = async (action: () => unknown): Promise<number> => {
  await settle();
  await settle(action);
  return setup.getNativeStats().cellsUpdated;
};

try {
  await settle();
  assert.match(setup.captureCharFrame(), /Welcome to clai/);

  const idle = await cellsRewrittenBy(() => setup.renderer.requestRender());
  assert.ok(idle < ALL_CELLS / 10, `an unchanged frame rewrote ${idle} cells`);

  const afterKey = await cellsRewrittenBy(() => setup.mockInput.pressKey(F5));
  assert.equal(redrawRequests, 1);
  assert.equal(afterKey, ALL_CELLS, "F5 must rewrite every cell");

  const afterCommand = await cellsRewrittenBy(() => services.commands.dispatch({ name: "redraw" }));
  assert.equal(redrawRequests, 2);
  assert.equal(afterCommand, ALL_CELLS, "/redraw must rewrite every cell");

  await settle(() => services.overlay.openPager("Output", "line\n".repeat(80), undefined, undefined, "plain"));
  assert.equal(services.focus.activeContext(), "pager");
  const behindPager = await cellsRewrittenBy(() => setup.mockInput.pressKey(F5));
  assert.equal(redrawRequests, 3);
  assert.equal(behindPager, ALL_CELLS, "F5 must rewrite every cell behind an overlay");
  assert.equal(services.focus.activeContext(), "pager", "the pager must stay open");

  console.log("Native screen redraw passed: F5 and /redraw rewrite the whole screen, including behind a pager");
} finally {
  await act(async () => {
    services.dispose();
    setup.renderer.destroy();
  });
  await setup.renderer.idle();
}
