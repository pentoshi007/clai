import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export interface RendererSuspendPort {
  suspend(): void;
  resume(): void;
  writeScrollback?: ((text: string) => void) | undefined;
}

export interface PagerExportResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface PagerExportPort {
  exportToScrollback(title: string, body: string): PagerExportResult;
  exportToEditor(body: string): Promise<PagerExportResult>;
}

export function defaultEditor(): string {
  return (
    process.env.EDITOR ||
    process.env.VISUAL ||
    (process.platform === "win32" ? "notepad" : "vi")
  );
}

export function scrollbackExportText(title: string, body: string): string {
  const header = `\n\n── clai export: ${title} ──\n`;
  const footer = `\n── end export ──\n\n`;
  return `${header}${body.endsWith("\n") ? body : `${body}\n`}${footer}`;
}

function failure(error: unknown): PagerExportResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function writeScrollback(renderer: RendererSuspendPort, text: string): void {
  if (renderer.writeScrollback) {
    renderer.writeScrollback(text);
    return;
  }
  process.stdout.write("\x1b[?1049l");
  process.stdout.write(text);
}

export function createPagerExportPort(renderer: RendererSuspendPort): PagerExportPort {
  return {
    exportToScrollback(title, body) {
      try {
        renderer.suspend();
        writeScrollback(renderer, scrollbackExportText(title, body));
        return { ok: true };
      } catch (error) {
        return failure(error);
      } finally {
        try {
          renderer.resume();
        } catch {
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
        return failure(error);
      } finally {
        try {
          renderer.resume();
        } catch {
        }
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
