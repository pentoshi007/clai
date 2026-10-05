import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { createCompositionRoot } from '../../src/ui-core/bootstrap/composition-root.js';
import { detectCapabilities } from '../../src/ui-core/bootstrap/capabilities.js';
import { handleProvider } from '../../src/ui-core/commands/picker-commands.js';
import { ServicesProvider } from '../../src/ui-core/react/providers.js';
import { App } from '../../src/tui-v2/app/App.js';

for (const width of [80, 120]) {
  const services = createCompositionRoot({
    persistence: {
      async saveSession() {}, async loadPlan() { return undefined; },
      async savePlan() {}, async deletePlan() {},
    },
    capabilities: detectCapabilities({ env: { COLORTERM: 'truecolor' }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 35 }),
  });
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
    width, height: 35, kittyKeyboard: true, useMouse: true, useThread: false,
  });
  async function settle(action: () => unknown = () => undefined): Promise<string> {
    await act(async () => { await action(); });
    await act(async () => { await setup.flush(); });
    return setup.captureCharFrame().replace(/\s+/g, ' ');
  }
  try {
    await settle(() => handleProvider(services, { name: 'provider', args: '' }));
    await settle();
    for (const char of 'qoder') await settle(() => setup.mockInput.pressKey(char));
    const frame = await settle();
    assert.ok(frame.includes('Qoder'), frame);
    assert.ok(frame.includes('(https://api1.qoder.sh)'), frame);
    assert.equal(services.focus.activeContext(), 'picker');
    await settle(() => setup.mockInput.pressEscape());
    assert.equal(services.overlay.getState().kind, 'none');
    assert.equal(services.focus.activeContext(), 'composer');
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
console.log('Native Qoder picker passed at 80/120 columns');
