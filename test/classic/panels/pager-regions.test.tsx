import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGER_INITIAL_STATE, pagerLines, pagerView } from "../../../src/classic/panels/pager-panel.js";
import { paintSearchMatches } from "../../../src/classic/panels/pager-search-paint.js";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import { PanelHost } from "../../../src/classic/panels/panel-host.js";
import { stripAnsi } from "../../../src/classic/render/measure.js";
import { syntaxColor } from "../../../src/ui-core/rendering/file-diff-view.js";
import { openToolOutputPager } from "../../../src/ui-core/rendering/open-tool-output.js";
import { createTextPagerSource } from "../../../src/ui-core/rendering/artifact-pager-source.js";
import { colorInk, createHarness, ink } from "./harness.js";

vi.setConfig({ testTimeout: 30_000 });

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const keyword = (text: string) => colorInk.hex(syntaxColor("keyword", colorInk.theme), text);
const opening = (paint: (text: string) => string, text: string) => `${paint("\u0000").split("\u0000")[0]!}${text}`;

describe("classic pager regions", () => {
  it.each([['running', 'userBorder'], ['success', 'success'], ['failed', 'diffDel']] as const)("paints %s commands with %s, including wrapped rows", (inputTone, token) => {
    const command = `command: npm run build -- --filter ${"x".repeat(90)}`;
    const body = `${command}\n\n${"o".repeat(120)}`;
    const painted = pagerLines(body, 60, 20, "raw", false, undefined, { ink: colorInk, regions: { inputEnd: 1, inputTone } });
    const plain = pagerLines(body, 60, 20, "raw", false, undefined);
    expect(painted.map(stripAnsi)).toEqual(plain);
    const inputRows = plain.findIndex((line) => line.startsWith("o"));
    expect(inputRows).toBeGreaterThan(2);
    for (const [index, line] of painted.slice(0, inputRows - 1).entries()) {
      expect(line).toBe(colorInk.fg(token, plain[index]!));
    }
    expect(painted[inputRows]).toBe(colorInk.fg("foreground", plain[inputRows]!));
  });

  it("highlights fs.read code only inside the code region and keeps tokens whole across wraps", () => {
    const body = ["file: sample.ts", "", "export const answer = 42;", "", "── full file ──", "sample.ts"].join("\n");
    const painted = pagerLines(body, 80, 20, "raw", false, undefined, {
      path: "sample.ts",
      ink: colorInk,
      regions: { codeStart: 2, codeEnd: 3 },
    });
    expect(painted[0]).toBe(colorInk.fg("foreground", "file: sample.ts"));
    expect(painted[2]).toContain(keyword("export"));
    expect(painted[2]).toContain(colorInk.hex(syntaxColor("number", colorInk.theme), "42"));
    expect(painted[4]).toBe(colorInk.fg("foreground", "── full file ──"));
    const wrapped = pagerLines(`${"a".repeat(20)} constant`, 14, 20, "raw", false, undefined, {
      path: "x.ts",
      ink: colorInk,
      regions: { codeStart: 0 },
    });
    expect(wrapped.map(stripAnsi).join("")).toBe(`${"a".repeat(20)} constant`);
    expect(wrapped.join("")).not.toContain(keyword("const"));
  });

  it("leaves diff pagers and uncoloured terminals untouched", () => {
    const diff = ["  1 │ + const added = 1", "  2 │   const kept = 2"].join("\n");
    const withRegions = pagerLines(diff, 80, 8, "raw", false, undefined, { path: "a.ts", ink: colorInk, regions: { codeStart: 0 } });
    const withoutRegions = pagerLines(diff, 80, 8, "raw", false, undefined, { path: "a.ts", ink: colorInk });
    expect(withRegions).toEqual(withoutRegions);
    expect(withRegions.join("\n")).toContain(colorInk.fg("diffAdd", "│ "));
    const mono = pagerLines("command: ls\n\nout", 80, 8, "raw", false, undefined, { ink, regions: { inputEnd: 1 } });
    expect(mono).toEqual(pagerLines("command: ls\n\nout", 80, 8, "raw", false, undefined));
    expect(mono.join("")).not.toContain("\x1b[");
  });

  it.each([["ok", "success"], ["failed", "diffDel"], ["blocked", "diffDel"]] as const)("paints a real %s shell.exec pager", async (status, token) => {
    const harness = createHarness({ columns: 100, rows: 12 });
    const services = {
      overlay: harness.overlay,
      session: { notice() {}, spool: { tail: () => "built ok" } },
    } as never;
    await openToolOutputPager(services, {
      toolCallId: "shell-classic",
      name: "shell.exec",
      argsDisplay: "npm run build",
      artifactPath: undefined,
      status,
    } as never);
    const frame = render(
      <PanelHost controller={harness.panels} ink={colorInk} columns={100} rows={12} jobs={harness.jobs} transcript={harness.transcript} now={0} />,
    ).lastFrame() ?? "";
    expect(frame).toContain(opening((text) => colorInk.fg(token, text), "command: npm run build"));
    expect(frame).toContain(opening((text) => colorInk.fg("foreground", text), "built ok"));
  });

  it("highlights a real fs.read pager opened from the transcript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clai-classic-fs-read-"));
    tempDirs.push(dir);
    const path = join(dir, "sample.ts");
    await writeFile(path, "export const answer = 42;\n");
    const harness = createHarness({ columns: 100, rows: 12 });
    const services = { overlay: harness.overlay, session: { notice() {}, spool: { tail: () => "" } } } as never;
    await openToolOutputPager(services, { toolCallId: "fs-classic", name: "fs.read", argsDisplay: path, artifactPath: undefined } as never);
    const frame = render(
      <PanelHost controller={harness.panels} ink={colorInk} columns={100} rows={12} jobs={harness.jobs} transcript={harness.transcript} now={0} />,
    ).lastFrame() ?? "";
    expect(frame).toContain(opening(keyword, "export"));
    expect(frame).toContain(opening((text) => colorInk.hex(syntaxColor("number", colorInk.theme), text), "42"));
    expect(stripAnsi(frame)).toContain("export const answer = 42;");
  });

  it("drops page-zero regions once a paged body moves past its first page", async () => {
    const lines = Array.from({ length: 600 }, (_, index) => `row ${String(index).padStart(6, "0")}`);
    const source = createTextPagerSource(`command: seq\n\n${lines.join("\n")}`, "memory://seq", 1024);
    const first = await source.readPage(0);
    const harness = createHarness({ columns: 100, rows: 220 });
    harness.overlay.openPager("seq", first.body, source, undefined, "plain", { inputEnd: 1 });
    await vi.waitFor(() => expect(harness.panels.getSnapshot().pagerBody).toBe(first.body));
    const mount = () => render(
      <PanelHost controller={harness.panels} ink={colorInk} columns={100} rows={220} jobs={harness.jobs} transcript={harness.transcript} now={0} />,
    ).lastFrame() ?? "";
    expect(mount()).toContain(opening((text) => colorInk.fg("userBorder", text), "command: seq"));
    harness.press("shift+g");
    await vi.waitFor(() => expect(harness.panels.getSnapshot().pagerPageOffset).toBeGreaterThan(0));
    const firstShown = harness.panels.getSnapshot().pagerBody.split("\n")[0]!;
    expect(firstShown).not.toBe("");
    const frame = mount();
    expect(stripAnsi(frame)).toContain(firstShown);
    expect(frame).not.toContain(opening((text) => colorInk.fg("userBorder", text), firstShown));
    harness.overlay.close();
  });
});

describe("classic pager search keeps colours", () => {
  const keywordOpen = colorInk.hex(syntaxColor("keyword", colorInk.theme), "\u0000").split("\u0000")[0]!;
  const inverseOpen = colorInk.inverse("\u0000").split("\u0000")[0]!;
  const body = ["file: sample.ts", "", "export const answer = 42;", "export function other() {}", ""].join("\n");
  const paint = { path: "sample.ts", ink: colorInk, regions: { codeStart: 2, codeEnd: 4 } };

  it("highlights only the match and leaves syntax colours on matching and non-matching rows", () => {
    const lines = pagerLines(body, 80, 12, "raw", false, undefined, paint);
    const plain = lines.map(stripAnsi);
    const frame = pagerView({ ink: colorInk, columns: 80, rows: 12, title: "fs.read", lines, state: { ...PAGER_INITIAL_STATE, format: "raw", query: "answer" } });
    const rows = panelFrameRows(frame).rows;
    const matchRow = rows.find((row) => stripAnsi(row).includes("export const answer"))!;
    const otherRow = rows.find((row) => stripAnsi(row).includes("export function other"))!;
    expect(matchRow).toContain(`${keywordOpen}export`);
    expect(matchRow).toContain(`${inverseOpen}answer`);
    expect(otherRow).toContain(`${keywordOpen}export`);
    expect(otherRow).not.toContain(inverseOpen);
    expect(rows.map(stripAnsi).join("\n")).toContain(plain[2]!);
  });

  it("keeps the match highlighted across colour resets inside it", () => {
    const styled = `\u001b[31mab\u001b[0mcd\u001b[32mef\u001b[39m`;
    const painted = paintSearchMatches(colorInk, styled, [{ text: "a", kind: "plain" }, { text: "bcde", kind: "match" }, { text: "f", kind: "plain" }]);
    expect(stripAnsi(painted)).toBe("abcdef");
    const resetAt = painted.indexOf("\u001b[0m");
    expect(painted.slice(resetAt, resetAt + 4 + inverseOpen.length)).toBe(`\u001b[0m${inverseOpen}`);
    expect(painted.indexOf(inverseOpen)).toBeLessThan(painted.indexOf("b"));
    expect(paintSearchMatches(ink, styled, [{ text: "abcdef", kind: "match" }])).toBe(styled);
  });
});
