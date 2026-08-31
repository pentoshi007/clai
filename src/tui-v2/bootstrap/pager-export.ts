
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
  process.stdout.write("\x1b[?1049l");
  process.stdout.write(text);
  try {
    const out = process.stdout as NodeJS.WriteStream & {
      _handle?: { setBlocking?: (v: boolean) => void };
    };
    out._handle?.setBlocking?.(true);
  } catch {
  }
}

export function createPagerExportPort(renderer: OpenTuiSuspendPort): PagerExportPort {
  return createNeutralPagerExportPort({
    suspend: () => renderer.suspend(),
    resume: () => renderer.resume(),
    writeScrollback: writeToMainScrollback,
  });
}
