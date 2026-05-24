import { readFile } from "node:fs/promises";
import chalk from "chalk";

export interface OutputViewport {
  /** Display name for the tool (e.g. "shell.exec", "nmap"). */
  toolName: string;
  /** Short args display (e.g. the command line). */
  argsDisplay: string;
  /** Path to the raw artifact file on disk (if present). */
  artifactPath?: string | undefined;
  /** AI-facing reduced summary shown to the user as well. */
  summary: string;
  /** Whether the user has expanded the full output via Ctrl+O / /output. */
  expanded: boolean;
  /** Timestamp the viewport was registered (for /output last). */
  createdAt: number;
  /** Unique id; users can refer to it via /output <id>. */
  id: string;
}

let viewportCounter = 0;
const viewports = new Map<string, OutputViewport>();
let lastViewportId: string | undefined;

export function newViewportId(toolName: string): string {
  viewportCounter += 1;
  return `${toolName.replace(/\W+/g, "-")}-${viewportCounter}`;
}

export function registerViewport(
  partial: Omit<OutputViewport, "id" | "expanded" | "createdAt"> & { id?: string | undefined },
): OutputViewport {
  const id = partial.id ?? newViewportId(partial.toolName);
  const v: OutputViewport = {
    ...partial,
    id,
    expanded: false,
    createdAt: Date.now(),
  };
  viewports.set(id, v);
  lastViewportId = id;
  return v;
}

export function getViewport(id: string): OutputViewport | undefined {
  return viewports.get(id);
}

export function getLastViewport(): OutputViewport | undefined {
  if (!lastViewportId) return undefined;
  return viewports.get(lastViewportId);
}

export function listViewports(): OutputViewport[] {
  return [...viewports.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Toggle expansion and render either the full artifact (when expanding) or
 * a collapse confirmation (when collapsing). Used both by the Ctrl+O key
 * handler and the /output slash command so the two paths agree.
 */
export async function toggleViewport(
  id: string,
  write: (chunk: string) => void = (c) => process.stdout.write(c),
): Promise<boolean> {
  const v = viewports.get(id);
  if (!v) return false;
  v.expanded = !v.expanded;
  if (v.expanded) {
    write(chalk.dim(`\n  ── full output for ${v.toolName} (${v.argsDisplay}) ──\n`));
    if (v.artifactPath) {
      try {
        const raw = await readFile(v.artifactPath, "utf8");
        write(raw);
        if (!raw.endsWith("\n")) write("\n");
      } catch (error) {
        write(
          chalk.yellow(`  (could not read artifact: ${error instanceof Error ? error.message : String(error)})\n`),
        );
      }
    } else {
      write(chalk.dim("  (no artifact file — only the summary is available)\n"));
    }
    write(chalk.dim(`  ── summary still shown below; press Ctrl+O again to collapse ──\n`));
    // Re-print summary so the user has it without scrolling.
    write(`${v.summary}\n`);
  } else {
    write(chalk.dim(`\n  ── collapsed; press Ctrl+O to expand ──\n`));
  }
  return true;
}

export function clearViewports(): void {
  viewports.clear();
  lastViewportId = undefined;
}

export function formatViewportHint(v: OutputViewport): string {
  const hints: string[] = [];
  if (process.stdout.isTTY) hints.push("Ctrl+O");
  hints.push("/output last");
  if (v.artifactPath) hints.push(`/output ${v.id}`);
  return chalk.dim(
    `  ${hints.join(" or ")} to ${v.expanded ? "collapse" : "show full output"}${v.artifactPath ? ` (${v.artifactPath})` : ""}`,
  );
}
