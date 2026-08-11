/**
 * OpenTUI adapter for pager export (PICK-003, V2-074).
 *
 * The neutral export policy lives in `ui-core/ports/pager-export-port.ts`.
 * This file owns the only OpenTUI-specific part: leaving the alternate screen
 * so exported text lands in the terminal emulator's own scrollback, and
 * forcing a blocking flush before the renderer resumes.
 */

import {
  createPagerExportPort as createNeutralPagerExportPort,
  type PagerExportPort,
  type PagerExportResult,
  type RendererSuspendPort,
} from "../../ui-core/ports/pager-export-port.js";

export type { PagerExportPort, PagerExportResult, RendererSuspendPort };

export interface OpenTuiSuspendPort {
  suspend(): void;
  resume(): void;
}

function writeToMainScrollback(text: string): void {
  // Leave the alternate screen before dumping, or the export never reaches
  // the emulator's scrollback.
  process.stdout.write("\x1b[?1049l");
  process.stdout.write(text);
  try {
    const out = process.stdout as NodeJS.WriteStream & {
      _handle?: { setBlocking?: (v: boolean) => void };
    };
    out._handle?.setBlocking?.(true);
  } catch {
    // ignore
  }
}

export function createPagerExportPort(renderer: OpenTuiSuspendPort): PagerExportPort {
  return createNeutralPagerExportPort({
    suspend: () => renderer.suspend(),
    resume: () => renderer.resume(),
    writeScrollback: writeToMainScrollback,
  });
}
