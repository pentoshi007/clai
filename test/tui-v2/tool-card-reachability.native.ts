import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { transcriptScrollPort } from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";
import { EventSequencer, createCountingIdFactory } from "../../src/app/events/sequencer.js";
import { asMessageId, asPlanId, asSessionId, asToolCallId, asTurnId } from "../../src/app/events/app-event.js";
import { createPlan } from "../../src/store/plan.js";

function findScrollBox(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node;
  for (const child of node.getChildren()) {
    const found = findScrollBox(child);
    if (found) return found;
  }
  return undefined;
}

for (const [width, height] of [[180, 50], [180, 51], [140, 40], [140, 41], [92, 28], [80, 20], [52, 24], [40, 16]]) {
  const services = createCompositionRoot({
    noHistory: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: height }),
  });
  const seq = new EventSequencer(asSessionId("card-native"), createCountingIdFactory("card"));
  const turn = asTurnId("card-turn");
  for (let index = 0; index < 60; index += 1) {
    services.transcript.dispatch(seq.build("assistant-message", {
      messageId: asMessageId(`message-${index}`), text: `MESSAGE_${index}\n${"body\n".repeat(5)}END_${index}`,
    }, turn));
  }
  const plan = createPlan({ sessionId: services.session.sessionId, goal: "Tool card reachability", detail: "", taskTitles: ["Inspect", "Verify", "Finish"], kind: "ui" });
  const planEvent = seq.build("plan-updated", { planId: asPlanId("card-plan"), plan });
  services.plan.observe(planEvent);
  services.transcript.dispatch(planEvent);
  services.transcript.dispatch(seq.build("turn-started", { prompt: "Keep the last tool fully readable" }, turn));
  const toolCallId = asToolCallId("last-shell");
  services.transcript.dispatch(seq.build("tool-call", { toolCallId, name: "shell.exec", argsDisplay: `set -e\nagent-browser --session sample set viewport 375 812\n${"next command\n".repeat(30)}` }, turn));
  services.transcript.dispatch(seq.build("tool-started", { toolCallId }, turn));
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width, height, useThread: false, useMouse: true });

  async function settle(action: () => unknown = () => undefined): Promise<void> {
    await act(async () => { await action(); });
    await act(async () => { await setup.flush(); });
  }

  function assertBottom(label: string): void {
    const sb = findScrollBox(setup.renderer.root)!;
    const last = sb.content.getChildren().at(-1)!;
    const bottom = last.y + last.height;
    const viewportBottom = sb.viewport.y + sb.viewport.height;
    const frame = setup.captureCharFrame();
    const geometry = `${label} ${width}x${height} top=${sb.scrollTop} max=${sb.scrollHeight - sb.viewport.height} content=${sb.content.height} last=${last.y}+${last.height} viewport=${sb.viewport.y}+${sb.viewport.height}`;
    assert.ok(bottom <= viewportBottom, `${geometry}\n${frame}`);
    assert.ok(bottom <= sb.content.y + sb.content.height, geometry);
    assert.match(frame.split("\n")[bottom - 1] ?? "", /╰─.*╯/, `${geometry}\n${frame}`);
  }

  try {
    await settle();
    await settle(() => transcriptScrollPort.scrollToBottom());
    assertBottom("started");
    for (const count of [1, 3, 18]) {
      await settle(() => {
        const ref = services.session.spool.replace(toolCallId, `Done\n{\n  \"ready\": true,\n}\n${"growing output\n".repeat(count)}`);
        services.transcript.dispatch(seq.build("tool-output", { ref }, turn));
      });
      assertBottom(`output-${count}`);
    }
    await settle(() => services.transcript.dispatch(seq.build("tool-result", {
      toolCallId, ok: true, exitCode: 0, summary: "Done\n{\n  \"ready\": true,\n}\n", artifactPath: `/tmp/clai/sample/temp/${"long-output-path-".repeat(8)}set.txt`,
    }, turn)));
    await settle(() => transcriptScrollPort.scrollBy(1_000));
    assertBottom("completed");
    await settle(() => transcriptScrollPort.scrollBy(-5));
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    let frameId = -100;
    globalThis.requestAnimationFrame = (callback) => {
      const frame = --frameId;
      callback(performance.now());
      return frame;
    };
    globalThis.cancelAnimationFrame = (frame) => { if (frame >= 0) cancelFrame(frame); };
    try {
      await settle(() => {
        for (let notch = 0; notch < 5; notch += 1) transcriptScrollPort.wheel(1);
      });
      assertBottom("idle-wheel-restart");
      assert.equal(transcriptScrollPort.metrics.linesBelow, 0);
      assert.equal(frameId, -105, "a settled bottom needs no extra pin frames");
    } finally {
      globalThis.requestAnimationFrame = requestFrame;
      globalThis.cancelAnimationFrame = cancelFrame;
    }
    await settle(() => services.transcript.toggleOutputGlobal());
    await settle(() => transcriptScrollPort.scrollBy(1_000));
    assertBottom("expanded");
    await settle(() => services.session.enqueue("A queued follow-up"));
    await settle(() => transcriptScrollPort.scrollBy(1_000));
    assertBottom("queued");
    await settle(() => setup.mockInput.pressKey("h", { ctrl: true }));
    await settle(() => transcriptScrollPort.scrollBy(1_000));
    assertBottom("tasks-hidden");
    await settle(() => setup.resize(width - 12, height - 3));
    await settle(() => transcriptScrollPort.scrollBy(1_000));
    assertBottom("resized");
    assert.equal(services.transcript.getState().order.length, 62);
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
console.log("Native tool-card reachability passed");
