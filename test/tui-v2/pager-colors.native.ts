import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { openToolOutputPager } from "../../src/ui-core/rendering/open-tool-output.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { asToolCallId } from "../../src/app/events/app-event.js";

const directory = mkdtempSync(join(tmpdir(), "clai-pager-colors-"));
const source = join(directory, "sample.ts");
writeFileSync(source, ["export const SOURCE_ANSWER = 42;", "", "function greet(name: string) {", "  return `hi ${name}`;", "}", "──── section ────", "const AFTER_RULE = true;"].join("\n"));

try {
  for (const width of [100, 60]) {
    const services = createCompositionRoot({
      noHistory: true,
      persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
      capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 40 }),
    });
    const theme = themeFor(services.capabilities.themeHint);
    const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
      width, height: 40, kittyKeyboard: true, useMouse: true, useThread: false,
    });
    const settle = async (action: () => unknown = () => undefined): Promise<void> => {
      await act(async () => { await action(); });
      await act(async () => { await setup.flush(); });
    };
    const bodySpans = () => {
      const lines = setup.captureSpans().lines;
      const start = lines.findIndex((line) => line.spans.map((span) => span.text).join("").includes("command:")
        || line.spans.map((span) => span.text).join("").includes("file:"));
      return lines.slice(Math.max(0, start)).flatMap((line) => line.spans);
    };
    const spanWith = (text: string) => bodySpans().find((span) => span.text.includes(text));
    const waitFor = async (text: string) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await settle();
        const span = spanWith(text);
        if (span) return span;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Missing ${text}: ${setup.captureCharFrame()}`);
    };
    const color = (hex: string) => RGBA.fromHex(hex).toInts();
    try {
      const shell = asToolCallId("call-shell");
      services.session.spool.replace(shell, "SHELL_OUTPUT_ONE\nSHELL_OUTPUT_TWO");
      for (const [status, token] of [[undefined, "userBorder"], ["ok", "success"], ["failed", "diffDel"], ["blocked", "diffDel"]] as const) {
        await settle(() => openToolOutputPager(services, {
          toolCallId: shell, name: "shell.exec", argsDisplay: "printf INPUT_FIRST\n\nprintf INPUT_AFTER_BLANK", artifactPath: undefined, status,
        }));
        await waitFor("INPUT_FIRST");
        const border = setup.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("╭")));
        assert.ok(border, setup.captureCharFrame());
        const borderText = border.spans.map((span) => span.text).join("");
        assert.ok(borderText.includes("shell.exec"), borderText);
        assert.ok(!borderText.includes("INPUT_FIRST"), borderText);
        const borderTitle = border.spans.find((span) => span.text.includes("shell.exec"));
        assert.ok(borderTitle);
        assert.deepEqual(borderTitle.fg.toInts(), color(theme.cyan), "border title stays neutral");
        assert.deepEqual((await waitFor("INPUT_FIRST")).fg.toInts(), color(theme[token]), `${status} command input`);
        assert.deepEqual((await waitFor("INPUT_AFTER_BLANK")).fg.toInts(), color(theme[token]), `${status} input after a blank line`);
        assert.deepEqual((await waitFor("SHELL_OUTPUT_ONE")).fg.toInts(), color(theme.foreground), "output stays foreground");
        await settle(() => services.overlay.close());
      }

      const read = asToolCallId("call-read");
      services.session.spool.replace(read, "ok\nread");
      await settle(() => openToolOutputPager(services, {
        toolCallId: read, name: "fs.read", argsDisplay: source, artifactPath: undefined,
      }));
      await waitFor("SOURCE_ANSWER");
      const keyword = bodySpans().find((span) => span.text.trim() === "export");
      assert.ok(keyword, setup.captureCharFrame());
      assert.deepEqual(keyword.fg.toInts(), color(theme.synKeyword), "fs.read keywords are highlighted");
      const number = bodySpans().find((span) => span.text.trim() === "42");
      assert.ok(number);
      assert.notDeepEqual(number.fg.toInts(), color(theme.foreground), "fs.read numbers are highlighted");
      const after = bodySpans().find((span) => span.text.trim() === "AFTER_RULE");
      assert.ok(after, "file content after a box-drawing line is shown");
      assert.notDeepEqual(after.fg.toInts(), color(theme.chip), "file content after a box-drawing line stays highlighted");
      await settle(() => setup.mockInput.pressKey("r", { ctrl: true }));
      await settle(() => setup.mockInput.typeText("SOURCE_ANSWER"));
      await settle(() => setup.mockInput.pressEnter());
      const hit = await waitFor("SOURCE_ANSWER");
      assert.notDeepEqual(hit.bg.toInts(), color(theme.background), "the search match is highlighted");
      const matchedKeyword = bodySpans().find((span) => span.text.trim() === "export");
      assert.ok(matchedKeyword, setup.captureCharFrame());
      assert.deepEqual(matchedKeyword.fg.toInts(), color(theme.synKeyword), "keywords on the matching line keep their colour");
      const otherKeyword = bodySpans().find((span) => span.text.trim() === "function");
      assert.ok(otherKeyword);
      assert.deepEqual(otherKeyword.fg.toInts(), color(theme.synKeyword), "keywords on other lines keep their colour while searching");
      await settle(() => services.overlay.close());
    } finally {
      await act(async () => { services.dispose(); setup.renderer.destroy(); });
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("Native pager colors passed: status-aware shell input, foreground output and fs.read syntax highlighting, including while searching, at 100/60 columns");
