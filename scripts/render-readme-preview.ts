import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CapturedSpan } from "@opentui/core";
import type { HistoryRecord } from "../src/store/history.js";
import type { TranscriptItem } from "../src/app/ports/transcript-item.js";

const COLUMNS = 112;
const ROWS = 63;
const CELL_WIDTH = 8.4;
const LINE_HEIGHT = 18;
const PADDING = 16;
const TITLE_BAR = 30;
const output = resolve(process.argv[2] ?? ".github/assets/clai-opentui.svg");
const previewHome = process.env.CLAI_PREVIEW_HOME;

if (!previewHome) {
  const home = mkdtempSync(join(tmpdir(), "clai-preview-"));
  try {
    const result = spawnSync(process.execPath, [process.argv[1]!, output], {
      stdio: "inherit",
      env: {
        ...process.env,
        HOME: home,
        CLAI_PREVIEW_HOME: home,
        CLAI_CONFIG_DIR: join(home, "config"),
        CLAI_DATA_DIR: join(home, "data"),
        CLAI_HISTORY_DIR: join(home, "history"),
        CLAI_NO_UPDATE_CHECK: "1",
        CLAI_DISABLE_KEYCHAIN: "1",
        CLAI_OFFLINE: "1",
      },
    });
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  process.exit();
}

const project = join(previewHome, "projects", "api");
mkdirSync(project, { recursive: true });
const git = (...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=clai", "-c", "user.email=preview@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: project, stdio: "ignore" });
};
git("init", "--quiet", "--initial-branch=main");
git("commit", "--quiet", "--allow-empty", "-m", "preview");
process.chdir(project);

const { act, createElement } = await import("react");
const { testRender } = await import("@opentui/react/test-utils");
const { createCompositionRoot } = await import("../src/ui-core/bootstrap/composition-root.js");
const { detectCapabilities } = await import("../src/ui-core/bootstrap/capabilities.js");
const { ServicesProvider } = await import("../src/ui-core/react/providers.js");
const { App } = await import("../src/tui-v2/app/App.js");
const { applySessionResume } = await import("../src/ui-core/bootstrap/session-resume.js");
const { buildFileChange } = await import("../src/tools/file-diff.js");

const before = [
  "import express from \"express\";",
  "",
  "export const app = express();",
  "",
  "app.get(\"/users\", listUsers);",
  "",
].join("\n");
const after = [
  "import express from \"express\";",
  "",
  "export const app = express();",
  "",
  "app.get(\"/health\", (_req, res) => {",
  "  res.json({ status: \"ok\", uptime: process.uptime() });",
  "});",
  "",
  "app.get(\"/users\", listUsers);",
  "",
].join("\n");

const prompt = "Add a /health endpoint to the API and run the tests";
const transcript: TranscriptItem[] = [
  { kind: "user", id: "demo-user", text: prompt, done: true },
  { kind: "tool", id: "demo-read", name: "fs.read", argsDisplay: "src/server.ts", output: before, status: "ok", exitCode: 0, done: true, durationMs: 4 },
  {
    kind: "tool", id: "demo-edit", name: "fs.edit", argsDisplay: "src/server.ts", output: "", status: "ok", done: true, durationMs: 9,
    fileChanges: [buildFileChange({ path: "src/server.ts", before, after, kind: "edit" })],
  },
  {
    kind: "tool", id: "demo-test", name: "shell.exec", argsDisplay: "npm test -- health", status: "ok", exitCode: 0, done: true, durationMs: 2140,
    output: ["> api@1.4.0 test", "> vitest run health", "", " ✓ test/health.test.ts (2 tests) 18ms", "", " Test Files  1 passed (1)", "      Tests  2 passed (2)"].join("\n"),
  },
  {
    kind: "assistant", id: "demo-answer", streaming: false, done: true,
    text: [
      "Added `GET /health` in `src/server.ts`. It returns the service status and process uptime.",
      "",
      "- **Tests:** `npm test -- health` passes (2 tests).",
      "- **Next:** wire it into your load balancer's health check.",
    ].join("\n"),
  },
];

const record: HistoryRecord = {
  id: "demo-session",
  name: "Add a health endpoint",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  cwd: project,
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  messages: [
    { role: "user", content: prompt },
    { role: "assistant", content: "Added GET /health." },
  ],
  transcript,
};

function hex(color: CapturedSpan["fg"]): string {
  const [r, g, b] = color.toInts();
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderSvg(lines: readonly (readonly CapturedSpan[])[], background: string): string {
  const width = Math.ceil(COLUMNS * CELL_WIDTH + PADDING * 2);
  const height = Math.ceil(lines.length * LINE_HEIGHT + PADDING * 2 + TITLE_BAR);
  const rects: string[] = [];
  const texts: string[] = [];
  lines.forEach((spans, row) => {
    let column = 0;
    const y = TITLE_BAR + PADDING + row * LINE_HEIGHT;
    for (const span of spans) {
      const x = PADDING + column * CELL_WIDTH;
      const bg = hex(span.bg);
      if (bg !== background && span.bg.a > 0) {
        rects.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${(span.width * CELL_WIDTH).toFixed(1)}" height="${LINE_HEIGHT}" fill="${bg}"/>`);
      }
      if (span.text.trim()) {
        const bold = (span.attributes & 1) !== 0 ? ` font-weight="700"` : "";
        texts.push(`<text x="${x.toFixed(1)}" y="${y + 13}" fill="${hex(span.fg)}"${bold} textLength="${(span.width * CELL_WIDTH).toFixed(1)}" lengthAdjust="spacingAndGlyphs">${escapeXml(span.text)}</text>`);
      }
      column += span.width;
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="clai running in a terminal with the OpenTUI interface">`,
    `<rect width="${width}" height="${height}" rx="10" fill="${background}"/>`,
    `<rect width="${width}" height="${TITLE_BAR}" rx="10" fill="#1f2430"/>`,
    `<rect y="${TITLE_BAR - 10}" width="${width}" height="10" fill="#1f2430"/>`,
    `<circle cx="20" cy="15" r="6" fill="#ff5f57"/><circle cx="40" cy="15" r="6" fill="#febc2e"/><circle cx="60" cy="15" r="6" fill="#28c840"/>`,
    `<text x="${width / 2}" y="20" fill="#9aa4b2" font-size="13" text-anchor="middle" font-family="ui-sans-serif, -apple-system, Segoe UI, sans-serif">clai — ~/projects/api</text>`,
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="14" xml:space="preserve">`,
    ...rects,
    ...texts,
    "</g>",
    "</svg>",
    "",
  ].join("\n");
}

const services = createCompositionRoot({
  noHistory: true,
  mode: "agent",
  agent: { async runTurn() { throw new Error("preview only"); } },
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  updates: { async check() { return { state: "current", currentVersion: "preview", updateAvailable: false }; } },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: COLUMNS, rows: ROWS }),
});
await applySessionResume(services, record);
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: COLUMNS, height: ROWS, useThread: false,
});
try {
  for (let index = 0; index < 12; index += 1) {
    services.toast.clear();
    await act(async () => { await setup.flush(); await setup.renderer.idle(); });
    await act(async () => { await new Promise((resolveDelay) => setTimeout(resolveDelay, 150)); });
  }
  if (process.env.PREVIEW_TEXT === "1") console.log(setup.captureCharFrame());
  const frame = setup.captureSpans();
  const lines = frame.lines.map((line) => line.spans);
  while (lines.length > 0 && lines[0]!.every((span) => !span.text.trim())) lines.shift();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, renderSvg(lines, hex(frame.lines[0]!.spans[0]!.bg)));
  console.log(`wrote ${output}`);
} finally {
  await act(async () => { setup.renderer.destroy(); services.dispose(); });
}
process.exit(0);
