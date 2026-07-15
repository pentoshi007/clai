/**
 * Pager export to real terminal scrollback and `$EDITOR` (PICK-003, V2-074).
 *
 * Both paths need the real terminal back, not the alternate-screen buffer:
 * `renderer.suspend()`/`resume()` (used elsewhere for foreground child
 * processes) hands it over temporarily. Scrollback export just prints to the
 * now-restored main screen so the content lands in the terminal emulator's
 * own scrollback; editor export additionally spawns `$EDITOR`/`$PAGER` with
 * inherited stdio over a temp file. Neither result is read back — this is a
 * read-only export of pager content, not a round-trip edit.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export interface RendererSuspendPort {
  suspend(): void;
  resume(): void;
}

export interface PagerExportResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface PagerExportPort {
  exportToScrollback(title: string, body: string): PagerExportResult;
  exportToEditor(body: string): Promise<PagerExportResult>;
}

function defaultEditor(): string {
  return process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad" : "vi");
}

/**
 * Ensure text lands on the main-screen scrollback, not the alt buffer.
 * OpenTUI's suspend leaves alt-screen; we still force main-screen CSI so
 * dumps survive after resume (and after the process exits).
 */
function writeToMainScrollback(title: string, body: string): void {
  // Leave alt screen if still active, then print a clear dump block.
  process.stdout.write("\x1b[?1049l");
  const header = `\n\n── clai export: ${title} ──\n`;
  const footer = `\n── end export ──\n\n`;
  process.stdout.write(header);
  process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
  process.stdout.write(footer);
  // Flush so the terminal emulator commits to its scrollback before we
  // re-enter the alternate screen on resume.
  try {
    // @types/node: WriteStream has cork/uncork; force sync flush best-effort.
    const out = process.stdout as NodeJS.WriteStream & { _handle?: { setBlocking?: (v: boolean) => void } };
    out._handle?.setBlocking?.(true);
  } catch {
    // ignore
  }
}

export function createPagerExportPort(renderer: RendererSuspendPort): PagerExportPort {
  return {
    exportToScrollback(title, body) {
      try {
        renderer.suspend();
        writeToMainScrollback(title, body);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        try {
          renderer.resume();
        } catch {
          // Always try to restore the TUI even if resume throws.
        }
      }
    },
    async exportToEditor(body) {
      const dir = await mkdtemp(join(tmpdir(), "clai-pager-"));
      const file = join(dir, "output.txt");
      try {
        await writeFile(file, body, "utf8");
        renderer.suspend();
        await execa(defaultEditor(), [file], { stdio: "inherit" });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        try {
          renderer.resume();
        } catch {
          // ignore
        }
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
