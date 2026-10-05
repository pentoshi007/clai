import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { createCompositionRoot } from '../../src/ui-core/bootstrap/composition-root.js';
import { detectCapabilities } from '../../src/ui-core/bootstrap/capabilities.js';
import { ServicesProvider } from '../../src/ui-core/react/providers.js';
import { App } from '../../src/tui-v2/app/App.js';
import type { ArtifactPagerSource } from '../../src/ui-core/rendering/artifact-pager-source.js';

for (const width of [80, 120]) {
  const copied: string[] = [];
  let fullReads = 0;
  let disposals = 0;
  const body = ['PAGER_FIRST_MARKER', ...Array.from({ length: 140 }, (_, i) => `pager-line-${i}`), 'PAGER_LAST_MARKER'].join('\n');
  const source: ArtifactPagerSource = {
    path: 'memory://pager-regression', pageBytes: body.length,
    async readPage() { return { body, offset: 0, nextOffset: body.length, totalBytes: body.length, pageNumber: 1, pageCount: 1 }; },
    async readAll() { fullReads++; return body; },
    async search() { return undefined; },
    dispose() { disposals++; },
  };
  const services = createCompositionRoot({
    clipboard: { async writeText(text) { copied.push(text); }, async readText() { return ''; } },
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
  async function waitFor(text: string): Promise<string> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const frame = await settle();
      if (frame.includes(text)) return frame;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Missing ${text}: ${setup.captureCharFrame()}`);
  }
  try {
    for (const paged of [false, true]) {
      await settle(() => services.overlay.openPager('Pager regression', body, paged ? source : undefined, undefined, 'plain'));
      const initial = await waitFor('PAGER_FIRST_MARKER');
      assert.ok(!initial.includes('scrollback') && !initial.includes('e:editor'), initial);
      const beforeReads = fullReads;
      for (const key of ['s', 'e']) {
        await settle(() => setup.mockInput.pressKey(key));
        await settle(() => setup.mockInput.pressKey(key, { ctrl: true }));
        await settle(() => setup.mockInput.pressKey(key, { ctrl: true, shift: true }));
      }
      assert.equal(fullReads, beforeReads);
      assert.equal(services.overlay.getState().kind, 'pager');
      assert.equal(services.focus.activeContext(), 'pager');
      assert.equal(await settle(), initial);
      const scrolled = await settle(() => setup.mockInput.pressKey('\x1b[6~'));
      assert.notEqual(scrolled, initial);
      await settle(() => setup.mockInput.pressKey('c'));
      await waitFor('copied all');
      assert.equal(copied.at(-1), body);
      assert.equal(fullReads, beforeReads + Number(paged));
      await settle(() => setup.mockInput.pressKey('q'));
      assert.equal(services.overlay.getState().kind, 'none');
      assert.equal(services.focus.activeContext(), 'composer');
      assert.equal(disposals, Number(paged));
    }
    assert.match(await settle(() => setup.mockInput.typeText('still responsive')), /still responsive/);
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
console.log('Native pager removal passed: ignored export keys, paging, copy and composer at 80/120 columns');
