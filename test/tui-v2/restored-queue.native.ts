import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueuePanel } from "../../src/tui-v2/components/queue/queue-panel.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { createCurrentPersistencePort } from "../../src/app/adapters/current-store-adapter.js";
import { loadQueuedPrompts } from "../../src/store/session-queue.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

for (const width of [40, 100]) {
  const sessionId = `native-restored-queue-${width}`;
  const options = { sessionId, persistence: { ...createCurrentPersistencePort(), async saveSession() {} } };
  const previous = createCompositionRoot(options);
  previous.session.enqueue("RESTORED_OPENTUI_PROMPT");
  previous.dispose();
  const services = createCompositionRoot(options);
  assert.deepEqual(services.session.queued(), ["RESTORED_OPENTUI_PROMPT"]);
  const setup = await testRender(createElement(QueuePanel, { services, theme: themeFor("dark"), width, onEdit() {} }), {
    width, height: 12, useMouse: true, useThread: false,
  });
  try {
    await act(async () => { await setup.flush(); });
    const rows = setup.captureCharFrame().split("\n");
    assert.ok(rows.some((row) => row.includes("RESTORED")), rows.join("\n"));
    const y = rows.findIndex((row) => row.includes("[×]"));
    assert.ok(y >= 0, rows.join("\n"));
    await act(async () => { await setup.mockMouse.click(rows[y]!.indexOf("[×]") + 1, y); });
    await act(async () => { await setup.flush(); });
    assert.deepEqual(services.session.queued(), []);
    assert.deepEqual(loadQueuedPrompts(sessionId), []);
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
console.log("Native restored queue passed: restart recovery and persistent UI cancellation at 40/100 columns");
