import type { ClipboardPort } from "../ports/clipboard-port.js";

export interface InMemoryClipboard extends ClipboardPort {
  readonly lastText: string | undefined;
}

/**
 * App-layer default clipboard: stores the last copied text in memory without
 * touching the terminal. The real OSC 52 / native-clipboard adapter, which
 * writes terminal bytes, belongs to the renderer layer (Phase 6, SEL-006).
 */
export function createInMemoryClipboardPort(): InMemoryClipboard {
  let last: string | undefined;
  return {
    get lastText() {
      return last;
    },
    async writeText(text: string) {
      last = text;
    },
    async readText() {
      return last;
    },
  };
}
