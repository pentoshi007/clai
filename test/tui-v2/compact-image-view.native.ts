import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ToolCard } from "../../src/tui-v2/components/transcript/tool-card.js";
import { TerminalDimensionsContext } from "../../src/tui-v2/hooks/terminal-dimensions.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { asToolCallId, asTurnId } from "../../src/app/events/app-event.js";
import { formatToolArgs } from "../../src/agent/tool-call-parser.js";
import type { ToolItem } from "../../src/ui-core/state/transcript-types.js";

const paths = ["screenshots/before.png", "screenshots/after.png"];
const body = "[image.view] 1 image is attached to the next message\nPRIVATE_IMAGE_OUTPUT\n".repeat(100).trimEnd();
const artifactPath = "/missing/image-view-output.log";
const captures: string[] = [];
let scenarios = 0;
for (const width of [120, 40]) {
  for (const multiple of [false, true]) {
    for (const status of ["ok", "failed", "running", "blocked"] as const) {
      for (const expanded of [false, true]) {
        const services = createCompositionRoot({
          noHistory: true,
          persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
          capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 40 }),
        });
        const item: ToolItem = {
          id: "image-card", sequence: 1, turnId: asTurnId("turn-1"), timestamp: 0, kind: "tool", toolCallId: asToolCallId("call-image"),
          name: "image.view", argsDisplay: formatToolArgs({ name: "image.view", args: multiple ? { paths } : { path: paths[0]! } }),
          status, exitCode: status === "failed" ? 1 : 0,
          summary: status === "failed" ? "Image not found" : undefined,
          artifactPath, reason: status === "blocked" ? "Image access denied" : undefined,
          outputBytes: body.length, fileChanges: undefined,
        };
        services.session.spool.replace(item.toolCallId, body);
        const setup = await testRender(createElement(ServicesProvider, {
          services,
          children: createElement(TerminalDimensionsContext.Provider, {
            value: { width, height: 40 },
            children: createElement(ToolCard, {
              item, theme: themeFor(services.capabilities.themeHint), spool: services.session.spool,
              expanded, services, onToggle() { throw new Error("Compact image cards must open a pager, not expand inline"); },
              contentWidth: width,
            }),
          }),
        }), { width, height: 40, useThread: false, useMouse: true });
        async function settle(action: () => unknown = () => undefined): Promise<void> {
          await act(async () => { await action(); await new Promise((resolve) => setTimeout(resolve, 10)); });
          await act(async () => { await setup.flush(); });
        }
        try {
          await settle();
          const frame = setup.captureCharFrame();
          const card = setup.renderer.root.findDescendantById(item.id);
          assert.ok(card && card.height <= 8, `Image card is not compact at ${width} columns\n${frame}`);
          assert.match(frame, /image\.view/);
          assert.ok(!frame.includes("PRIVATE_IMAGE_OUTPUT"), frame);
          assert.ok(!frame.includes("OUTPUT"), frame);
          assert.ok(!frame.includes("image-view-output.log"), frame);
          assert.ok(!frame.includes("Ctrl+O"), frame);
          assert.ok(!frame.includes("expand all"), frame);
          assert.match(frame, /click to open pager/);
          if (status === "failed") assert.match(frame, /Image not found/);
          if (status === "blocked") assert.match(frame, /Image access denied/);
          assert.equal(services.session.spool.tail(item.toolCallId), body);
          if (width === 120) {
            assert.ok(frame.includes(paths[0]!), frame);
            if (multiple) assert.ok(frame.includes(paths[1]!), frame);
          }
          const lines = frame.split("\n");
          const row = lines.findIndex((line) => line.includes(expanded ? "image.view" : "click to open pager"));
          const column = lines[row]!.indexOf(expanded ? "image.view" : "click to open pager");
          await settle(() => setup.mockMouse.click(column + 1, row));
          const overlay = services.overlay.getState();
          assert.equal(overlay.kind, "pager", `Compact image card did not open a pager\n${frame}`);
          if (overlay.kind === "pager") {
            assert.equal(overlay.title, "image.view");
            const pagerBody = overlay.source ? await overlay.source.readAll() : overlay.body;
            assert.ok(pagerBody.includes(body), "Pager must retain full image attachment details");
            assert.ok(pagerBody.includes(paths[0]!), "Pager must retain the image input");
            if (multiple) assert.ok(pagerBody.includes(paths[1]!), "Pager must retain all image inputs");
          }
          if (status === "ok" && multiple && !expanded) captures.push(frame);
          scenarios += 1;
        } finally {
          await act(async () => { services.dispose(); setup.renderer.destroy(); });
          await setup.renderer.idle();
        }
      }
    }
  }
}
const capturePath = process.env.CLAI_IMAGE_CARD_CAPTURE;
if (capturePath) await writeFile(capturePath, JSON.stringify(captures));
assert.equal(scenarios, 32);
console.log(`Native compact image view passed: ${scenarios} single/multiple, status, expansion and click-to-pager scenarios`);
