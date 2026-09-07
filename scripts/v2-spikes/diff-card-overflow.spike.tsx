/** @jsxImportSource @opentui/react */
// Diff-card overflow regression spike (reported: long diff text runs through
// the card's right border in the OpenTUI UI; classic wraps/splits instead).
//
// Mounts the real FileDiffBody in OpenTUI's headless React test renderer
// (Bun-only native FFI) inside a scrollbox + bordered/padded card that mirrors
// the ToolCard chrome, inside a 40-column chat pane while the terminal
// context is 100 columns — the exact shape of a wide terminal with the tasks
// pane open. Asserts:
//   - every rendered card row keeps its left/right border columns intact;
//   - a long unbreakable token is split across multiple code rows (classic
//     parity: words are separated in parts, never past the boundary);
//   - no code character is silently dropped (chunk text survives rendering);
//   - a very long file path in the collapsed label is clipped, not overflowed.
//
// Run: bun run scripts/v2-spikes/diff-card-overflow.spike.tsx
import { testRender } from "@opentui/react/test-utils";
import { buildFileChange } from "../../src/tools/file-diff.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { TerminalDimensionsContext } from "../../src/tui-v2/hooks/terminal-dimensions.js";
import { FileDiffBody } from "../../src/tui-v2/components/transcript/file-diff-card.js";
import { check, makeResult, measure, note, printResult, type SpikeResult } from "./harness.js";

const TERM_WIDTH = 100;
const PANE_WIDTH = 40;
const FRAME_HEIGHT = 30;
const RIGHT_BORDER_COL = PANE_WIDTH - 1;
const HIDDEN_SCROLLBARS = { visible: false, showArrows: false } as const;

const Z_FILLER = "z".repeat(60);
const LONG_TOKEN_LINE = `const endpoint = "https://api.example.com/v1/${Z_FILLER}/tokens";`;
const LONG_PATH = `/tmp/${"deep/".repeat(18)}module.ts`;

function cardRows(lines: readonly string[]): string[] {
  const top = lines.findIndex((l) => l[0] === "╭");
  if (top < 0) return [];
  const rows: string[] = [];
  for (let i = top + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line[0] === "╰") break;
    rows.push(line);
  }
  return rows;
}

async function renderDiffCard(props: {
  diffExpanded: boolean;
  contentWidth?: number;
}): Promise<readonly string[]> {
  const setup = await testRender(
    <TerminalDimensionsContext.Provider value={{ width: TERM_WIDTH, height: FRAME_HEIGHT }}>
      <box style={{ width: PANE_WIDTH, flexDirection: "column" }}>
        <scrollbox
          scrollY
          scrollX={false}
          scrollbarOptions={HIDDEN_SCROLLBARS}
          verticalScrollbarOptions={HIDDEN_SCROLLBARS}
          horizontalScrollbarOptions={HIDDEN_SCROLLBARS}
          style={{ width: "100%", flexDirection: "column" }}
        >
          {}
          <box
            border
            borderStyle="rounded"
            style={{
              flexDirection: "column",
              width: "100%",
              paddingLeft: 1,
              paddingRight: 1,
              paddingTop: 0,
              paddingBottom: 0,
            }}
          >
            <FileDiffBody
              changes={[
                buildFileChange({
                  path: LONG_PATH,
                  before: "",
                  after: `${LONG_TOKEN_LINE}\nconst x = 1;`,
                  kind: "create",
                }),
              ]}
              theme={themeFor("dark")}
              diffExpanded={props.diffExpanded}
              onOpen={() => {}}
              {...(props.contentWidth !== undefined ? { contentWidth: props.contentWidth } : {})}
            />
          </box>
        </scrollbox>
      </box>
    </TerminalDimensionsContext.Provider>,
    { width: TERM_WIDTH, height: FRAME_HEIGHT },
  );
  try {
    await setup.flush();
    await setup.waitForVisualIdle({ quietFrames: 3, maxFrames: 30 });
    const frame = setup.captureCharFrame().split("\n");
    if (process.env.DIFF_DEBUG === "1") {
      console.log(`--- frame (${props.diffExpanded ? "expanded" : "collapsed"}) ---`);
      frame.forEach((l, i) => console.log(`${String(i).padStart(2)} |${l}|`));
    }
    return frame;
  } finally {
    setup.renderer.destroy();
    await setup.renderer.idle();
  }
}

function checkBorders(result: SpikeResult, rows: readonly string[], label: string): void {
  const broken = rows
    .map((row, i) => (row[0] !== "│" || row[RIGHT_BORDER_COL] !== "│" ? i : -1))
    .filter((i) => i >= 0);
  check(
    result,
    `${label}: every card row keeps both border columns intact`,
    broken.length === 0,
    broken.length === 0
      ? undefined
      : `rows ${broken.join(",")} clobbered the border (sample: ${JSON.stringify(
          rows[broken[0]]?.slice(0, TERM_WIDTH),
        )})`,
  );
}

async function runExpandedScenario(result: SpikeResult): Promise<void> {
  const lines = await renderDiffCard({ diffExpanded: true, contentWidth: PANE_WIDTH });
  const rows = cardRows(lines);
  check(result, "expanded diff renders a bordered card", rows.length > 0, `${rows.length} card rows`);
  checkBorders(result, rows, "expanded");

  const tokenRows = rows.filter((row) => row.includes("z"));
  check(
    result,
    "long token is split across multiple code rows",
    tokenRows.length >= 2,
    `${tokenRows.length} rows carry token text`,
  );

  const zCount = rows.reduce((sum, row) => sum + (row.match(/z/g)?.length ?? 0), 0);
  check(
    result,
    "no code characters are silently dropped",
    zCount === Z_FILLER.length,
    `expected ${Z_FILLER.length} z's, frame shows ${zCount}`,
  );

  const pastBorder = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line, i }) => i > 0 && line.slice(RIGHT_BORDER_COL).includes("z"));
  check(
    result,
    "no diff text lands at or beyond the right border column",
    pastBorder.length === 0,
    pastBorder.length === 0 ? undefined : `${pastBorder.length} rows spill past col ${RIGHT_BORDER_COL}`,
  );
  measure(result, "expandedCardRows", rows.length);
}

async function runCollapsedScenario(result: SpikeResult): Promise<void> {
  const lines = await renderDiffCard({ diffExpanded: false, contentWidth: PANE_WIDTH });
  const rows = cardRows(lines);
  check(result, "collapsed diff renders a bordered card", rows.length > 0, `${rows.length} card rows`);
  checkBorders(result, rows, "collapsed");

  const labelRow = rows.find((row) => row.includes("file")) ?? "";
  check(
    result,
    "long path in collapsed label is clipped with an ellipsis",
    labelRow.includes("…"),
    `label row: ${JSON.stringify(labelRow)}`,
  );
}

async function main(): Promise<SpikeResult> {
  const result = makeResult(
    "V2-DIFF-OVERFLOW",
    "diff card text never crosses the card border (OpenTUI)",
  );
  await runExpandedScenario(result);
  await runCollapsedScenario(result);
  note(result, `terminal=${TERM_WIDTH}cols, chat pane=${PANE_WIDTH}cols (tasks-pane-open shape)`);
  return result;
}

export async function runDiffCardOverflowSpike(): Promise<SpikeResult> {
  return main();
}

if (import.meta.main) {
  const spikeResult = await main();
  printResult(spikeResult);
  process.exit(spikeResult.passed ? 0 : 1);
}
