import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CapturedSpan } from "@opentui/core";
import stringWidth from "string-width";
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
  // realpath so macOS's /var -> /private/var symlink still resolves to "~".
  const home = mkdtempSync(join(realpathSync(tmpdir()), "clai-preview-"));
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
    output: ["> vitest run health", "✓ test/health.test.ts (2 tests) 18ms", "Tests  2 passed (2)"].join("\n"),
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

const ATTR_BOLD = 1 << 0;
const ATTR_ITALIC = 1 << 2;
const ATTR_UNDERLINE = 1 << 3;
const BASELINE = 13;
const LIGHT_STROKE = 1.2;
const HEAVY_STROKE = 2.4;

// Block elements are drawn as rectangles (fractions of a cell) so they tile
// without the gaps that font glyphs leave between rows.
const BLOCKS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  "█": [0, 0, 1, 1], "▀": [0, 0, 1, 0.5], "▄": [0, 0.5, 1, 0.5], "▌": [0, 0, 0.5, 1], "▐": [0.5, 0, 0.5, 1],
};
// Box-drawing arms: [up, right, down, left], 0 = none, 1 = light, 2 = heavy.
const BOX: Readonly<Record<string, readonly [number, number, number, number]>> = {
  "─": [0, 1, 0, 1], "━": [0, 2, 0, 2], "│": [1, 0, 1, 0], "┃": [2, 0, 2, 0],
  "┌": [0, 1, 1, 0], "┐": [0, 0, 1, 1], "└": [1, 1, 0, 0], "┘": [1, 0, 0, 1],
  "┏": [0, 2, 2, 0], "┓": [0, 0, 2, 2], "┗": [2, 2, 0, 0], "┛": [2, 0, 0, 2],
  "├": [1, 1, 1, 0], "┤": [1, 0, 1, 1], "┬": [0, 1, 1, 1], "┴": [1, 1, 0, 1], "┼": [1, 1, 1, 1],
  "╭": [0, 1, 1, 0], "╮": [0, 0, 1, 1], "╰": [1, 1, 0, 0], "╯": [1, 0, 0, 1],
};
const ROUNDED = new Set(["╭", "╮", "╰", "╯"]);
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

const fmt = (value: number): string => (Math.round(value * 100) / 100).toString();

function boxShape(char: string, x: number, y: number, color: string): string {
  const arms = BOX[char]!;
  const cx = x + CELL_WIDTH / 2;
  const cy = y + LINE_HEIGHT / 2;
  if (ROUNDED.has(char)) {
    const [up, right] = arms;
    const radius = CELL_WIDTH / 2;
    const vertical = up ? y : y + LINE_HEIGHT;
    const horizontal = right ? x + CELL_WIDTH : x;
    const vy = up ? cy - radius : cy + radius;
    const hx = right ? cx + radius : cx - radius;
    return `<path d="M${fmt(cx)} ${fmt(vertical)}V${fmt(vy)}Q${fmt(cx)} ${fmt(cy)} ${fmt(hx)} ${fmt(cy)}H${fmt(horizontal)}" fill="none" stroke="${color}" stroke-width="${LIGHT_STROKE}"/>`;
  }
  const parts: string[] = [];
  const [up, right, down, left] = arms;
  const stroke = (weight: number): number => (weight === 2 ? HEAVY_STROKE : LIGHT_STROKE);
  // Each arm extends half a stroke past the centre so junctions close cleanly.
  if (up) parts.push(`M${fmt(cx - stroke(up) / 2)} ${fmt(y)}h${fmt(stroke(up))}V${fmt(cy + stroke(up) / 2)}h${fmt(-stroke(up))}Z`);
  if (down) parts.push(`M${fmt(cx - stroke(down) / 2)} ${fmt(cy - stroke(down) / 2)}h${fmt(stroke(down))}V${fmt(y + LINE_HEIGHT)}h${fmt(-stroke(down))}Z`);
  if (left) parts.push(`M${fmt(x)} ${fmt(cy - stroke(left) / 2)}H${fmt(cx + stroke(left) / 2)}v${fmt(stroke(left))}H${fmt(x)}Z`);
  if (right) parts.push(`M${fmt(cx - stroke(right) / 2)} ${fmt(cy - stroke(right) / 2)}H${fmt(x + CELL_WIDTH)}v${fmt(stroke(right))}H${fmt(cx - stroke(right) / 2)}Z`);
  return `<path d="${parts.join("")}" fill="${color}"/>`;
}

function isPrivateUse(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0xe000 && code <= 0xf8ff;
}

function renderSvg(lines: readonly (readonly CapturedSpan[])[], background: string): string {
  const width = Math.ceil(COLUMNS * CELL_WIDTH + PADDING * 2);
  const height = Math.ceil(lines.length * LINE_HEIGHT + PADDING * 2 + TITLE_BAR);
  const backgrounds: string[] = [];
  const shapes: string[] = [];
  const texts: string[] = [];
  lines.forEach((spans, row) => {
    const y = TITLE_BAR + PADDING + row * LINE_HEIGHT;
    let column = 0;
    // Merge adjacent cells that share a background to avoid hairline seams.
    let run: { start: number; end: number; color: string } | undefined;
    const flushRun = (): void => {
      if (!run) return;
      backgrounds.push(`<rect x="${fmt(PADDING + run.start * CELL_WIDTH)}" y="${y}" width="${fmt((run.end - run.start) * CELL_WIDTH)}" height="${LINE_HEIGHT}" fill="${run.color}"/>`);
      run = undefined;
    };
    for (const span of spans) {
      const bg = hex(span.bg);
      const start = column;
      const end = column + span.width;
      if (bg !== background && span.bg.a > 0) {
        if (run && run.color === bg && run.end === start) run.end = end;
        else { flushRun(); run = { start, end, color: bg }; }
      } else {
        flushRun();
      }

      const fg = hex(span.fg);
      const attrs = [
        (span.attributes & ATTR_BOLD) !== 0 ? ` font-weight="700"` : "",
        (span.attributes & ATTR_ITALIC) !== 0 ? ` font-style="italic"` : "",
        (span.attributes & ATTR_UNDERLINE) !== 0 ? ` text-decoration="underline"` : "",
      ].join("");
      let glyphs: string[] = [];
      let positions: string[] = [];
      // Each word is its own element anchored at its cell, and each glyph also
      // carries its own x. Renderers that ignore per-glyph positions still
      // start every word on the grid; the rest pin every character exactly.
      const flushWord = (): void => {
        if (glyphs.length > 0) {
          texts.push(`<text x="${positions.join(" ")}" y="${y + BASELINE}" fill="${fg}"${attrs}>${escapeXml(glyphs.join(""))}</text>`);
        }
        glyphs = [];
        positions = [];
      };
      let cell = start;
      for (const { segment } of graphemes.segment(span.text)) {
        const cells = Math.max(1, stringWidth(segment));
        const x = PADDING + cell * CELL_WIDTH;
        const block = BLOCKS[segment];
        if (block) {
          flushWord();
          const [bx, by, bw, bh] = block;
          // A half-pixel overlap hides anti-aliasing seams between adjacent cells.
          shapes.push(`<rect x="${fmt(x + bx * CELL_WIDTH)}" y="${fmt(y + by * LINE_HEIGHT)}" width="${fmt(bw * CELL_WIDTH + 0.5)}" height="${fmt(bh * LINE_HEIGHT + 0.5)}" fill="${fg}"/>`);
        } else if (BOX[segment]) {
          flushWord();
          shapes.push(boxShape(segment, x, y, fg));
        } else if (!segment.trim() || isPrivateUse(segment)) {
          flushWord();
        } else if ([...segment].length === 1) {
          glyphs.push(segment);
          positions.push(fmt(x));
        } else {
          // Multi-code-point graphemes get their own element so per-glyph
          // positions never split them.
          flushWord();
          texts.push(`<text x="${fmt(x)}" y="${y + BASELINE}" fill="${fg}"${attrs}>${escapeXml(segment)}</text>`);
        }
        cell += cells;
      }
      flushWord();
      column = end;
    }
    flushRun();
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="clai running in a terminal with the OpenTUI interface">`,
    `<rect width="${width}" height="${height}" rx="10" fill="${background}"/>`,
    `<rect width="${width}" height="${TITLE_BAR}" rx="10" fill="#1f2430"/>`,
    `<rect y="${TITLE_BAR - 10}" width="${width}" height="10" fill="#1f2430"/>`,
    `<circle cx="20" cy="15" r="6" fill="#ff5f57"/><circle cx="40" cy="15" r="6" fill="#febc2e"/><circle cx="60" cy="15" r="6" fill="#28c840"/>`,
    `<text x="${width / 2}" y="20" fill="#9aa4b2" font-size="13" text-anchor="middle" font-family="ui-sans-serif, -apple-system, Segoe UI, sans-serif">clai — ~/projects/api</text>`,
    ...backgrounds,
    ...shapes,
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace" font-size="14">`,
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
