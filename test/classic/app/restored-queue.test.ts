import { createElement } from "react";
import { render } from "ink-testing-library";
import { expect, it } from "vitest";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { createCurrentPersistencePort } from "../../../src/app/adapters/current-store-adapter.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { loadQueuedPrompts } from "../../../src/store/session-queue.js";
import { createHarness } from "./harness.js";

it("renders the correct resumed session's durable queue and persists UI removal", async () => {
  const persistence = { ...createCurrentPersistencePort(), async saveSession() {} };
  const first = createHarness({ persistence });
  const id = first.services.session.sessionId;
  first.services.session.enqueue("RESTORED_CLASSIC_PROMPT");
  first.dispose();
  const h = createHarness({ persistence });
  h.services.session.loadHistory([], { sessionId: id });
  const view = render(createElement(ServicesProvider, { services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }) }));
  try {
    await expect.poll(() => view.lastFrame()).toContain("RESTORED_CLASSIC_PROMPT");
    h.wiring.handleData("\x1f");
    await expect.poll(() => view.lastFrame()).not.toContain("RESTORED_CLASSIC_PROMPT");
    expect(loadQueuedPrompts(id)).toEqual([]);
  } finally { view.unmount(); h.dispose(); }
});
