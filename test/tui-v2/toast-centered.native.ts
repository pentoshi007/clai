import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import { ToastController, type ToastLevel } from "../../src/ui-core/controllers/toast-controller.js";
import { ToastHost } from "../../src/tui-v2/components/toast/toast-host.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

const theme = themeFor("dark");
const cases: ReadonlyArray<{ message: string; level: ToastLevel }> = [
  { message: "Centered text", level: "info" },
  { message: "A longer toast wraps onto shorter continuation lines that must also be centered", level: "success" },
  { message: "保存完了 続行できます", level: "warn" },
  { message: "Failed", level: "error" },
];
let checkedRows = 0;
for (const width of [16, 40, 80, 120]) {
  for (const compact of [false, true]) {
    const toast = new ToastController();
    const setup = await testRender(createElement(ToastHost, { toast, theme, termWidth: width, termHeight: 24, compact }), {
      width, height: 24, useThread: false,
    });
    try {
      for (const item of cases) {
        await act(async () => {
          toast.show(item.message, { level: item.level, key: "layout", sticky: true });
          await new Promise<void>(resolve => setTimeout(resolve, 260));
          await setup.flush();
        });
        const plate = RGBA.fromHex(item.level === "success" ? theme.successBg : item.level === "error" ? theme.failedBg : theme.mode);
        const plateRows = setup.captureSpans().lines.filter(line =>
          line.spans.some(span => span.bg.equals(plate) && span.width > 0),
        ).length;
        const rows = setup.captureSpans().lines.flatMap(line => {
          const spans = line.spans.filter(span => span.bg.equals(plate));
          const text = spans.map(span => span.text).join("");
          return text.trim() ? [{ text, columns: spans.reduce((sum, span) => sum + span.width, 0) }] : [];
        });
        assert.ok(rows.length > 0, `toast must be visible at ${width} columns`);
        for (const row of rows) {
          const left = row.text.length - row.text.trimStart().length;
          const right = row.text.length - row.text.trimEnd().length;
          assert.ok(Math.abs(left - right) <= 1, `uncentered ${width}-column toast: ${JSON.stringify(row.text)}`);
          assert.ok(row.columns <= width, "toast plate must fit the native terminal width");
          checkedRows += 1;
        }
        if (!compact && width === 80 && item.message === "Failed") {
          assert.ok(
            rows[0]!.columns <= 20,
            `short toast must shrink to its content, got ${rows[0]!.columns} columns`,
          );
          assert.equal(plateRows, 1, "single-line toast must not reserve blank padding rows");
        }
        if (!compact) {
          assert.equal(plateRows, rows.length, "toast height must equal its wrapped body lines");
        }
        if (compact) assert.equal(rows.length, 1, "overlay toast must stay on one row");
      }
      if (!compact) {
        for (const messages of [
          ["first toast", "second toast", "third toast"],
          [
            "The first notification wraps over several lines in narrow terminals",
            "Another notification with a different height must keep the same tight spacing",
            "The newest notification stays at the top even when its message wraps",
          ],
        ]) {
          await act(async () => {
            toast.clear();
            toast.show(messages[0]!, { level: "info", key: "stack-a", sticky: true });
            toast.show(messages[1]!, { level: "success", key: "stack-b", sticky: true });
            await new Promise<void>(resolve => setTimeout(resolve, 260));
            await setup.flush();
          });
          for (const count of [2, 3]) {
            if (count === 3) {
              await act(async () => {
                toast.show(messages[2]!, { level: "error", key: "stack-c", sticky: true });
                await new Promise<void>(resolve => setTimeout(resolve, 260));
                await setup.flush();
              });
            }
            const lines = setup.captureSpans().lines;
            const plates = count === 3
              ? [theme.failedBg, theme.successBg, theme.mode]
              : [theme.successBg, theme.mode];
            let nextRow = 0;
            for (const color of plates) {
              const plate = RGBA.fromHex(color);
              const rows = lines.flatMap((line, index) =>
                line.spans.some(span => span.bg.equals(plate) && span.width > 0) ? [index] : []);
              assert.ok(rows.length > 0, `${count}-toast stack must show every toast at ${width} columns`);
              assert.equal(rows[0], nextRow, "toasts must start at the top with one blank row between their bodies");
              nextRow = rows.at(-1)! + 2;
            }
          }
        }
      }
      await act(async () => { toast.clear(); await setup.flush(); });
      assert.equal(setup.captureCharFrame().trim(), "", "dismissal must remove the toast");
    } finally {
      await act(async () => { toast.dispose(); setup.renderer.destroy(); });
      await setup.renderer.idle();
    }
  }
}
console.log(`Native centered toasts passed: ${checkedRows} severity, wrapped and CJK rows in normal/compact modes at 16/40/80/120 columns`);
