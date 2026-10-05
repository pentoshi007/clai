import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { ClassicApp } from "../../src/classic/app/ClassicApp.js";
import { createClassicAppWiring } from "../../src/classic/app/app-wiring.js";
import { installQoderRuntimeFetch } from "../fixtures/qoder-runtime-fetch.js";
import { exerciseQoderUi, type QoderUiKey } from "../fixtures/qoder-ui-scenario.js";

const width = Number(process.argv[2]);
assert.ok([80, 120].includes(width));
const fixture = installQoderRuntimeFetch();
const services = createCompositionRoot({
  provider: "free", noHistory: true,
  persistence: {
    async saveSession() {}, async loadPlan() { return undefined; },
    async savePlan() {}, async deletePlan() {},
  },
  capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 35 }),
});
attachCommandHandlers(services);
const wiring = createClassicAppWiring({ services, mouse: false, resizeSource: { columns: width, rows: 35, on() {}, off() {} } });
const ui = render(createElement(ServicesProvider, { services, children: createElement(ClassicApp, { wiring }) }));
async function frame(): Promise<string> {
  await delay(25);
  return (ui.lastFrame() ?? "").replace(/\s+/g, " ");
}
const keys: Record<Exclude<QoderUiKey, "add">, string> = {
  escape: "\x1b", enter: "\r", up: "\x1b[A", down: "\x1b[B", activate: " ",
  disable: "d", remove: "\x04", save: "\x13", reset: "\x12", refresh: "r",
};
try {
  await exerciseQoderUi({
    services, frame,
    async key(value) {
      if (value === "add") { wiring.handleData(keys.up); wiring.handleData(keys.enter); }
      else wiring.handleData(keys[value]);
      await frame();
    },
    async paste(text) { wiring.handleData(`\x1b[200~${text}\x1b[201~`); await frame(); },
  }, fixture);
} finally {
  ui.unmount(); ui.cleanup(); wiring.dispose(); services.dispose(); fixture.restore();
}
console.log(`Classic Qoder auth passed at ${width} columns`);
