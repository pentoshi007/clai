/**
 * Run a single OpenTUI spike and exit with 0/1.
 * Invoked as a child process so a native segfault cannot take down the suite.
 *
 * Usage: bun run scripts/v2-spikes/run-one.ts <viewport|markdown|shell>
 */
import { printResult, type SpikeResult } from "./harness.js";

const kind = (process.argv[2] ?? "").toLowerCase();

async function main(): Promise<SpikeResult> {
  if (kind === "viewport" || kind === "viewport-culling" || kind === "v2-013") {
    const { runViewportCullingSpike } = await import("./viewport-culling.spike.js");
    return runViewportCullingSpike();
  }
  if (kind === "markdown" || kind === "streaming-markdown" || kind === "v2-014") {
    const { runStreamingMarkdownSpike } = await import("./streaming-markdown.spike.js");
    return runStreamingMarkdownSpike();
  }
  if (kind === "shell" || kind === "shell-render" || kind === "v2-032") {
    // .tsx spike — Bun resolves the extension.
    const { runShellRenderSpike } = await import("./shell-render.spike.js");
    return runShellRenderSpike();
  }
  throw new Error(
    `Unknown spike "${kind}". Use: viewport | markdown | shell`,
  );
}

try {
  const result = await main();
  printResult(result);
  // Force a clean exit so OpenTUI native teardown cannot segfault after PASS.
  process.exit(result.passed ? 0 : 1);
} catch (error) {
  console.error(
    `[FAIL] spike threw: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
