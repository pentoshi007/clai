import type { ClipboardPort } from "../../app/ports/clipboard-port.js";
import { notify, type NotifyTarget } from "../notify.js";

export interface CodeBlockCopyTarget extends NotifyTarget {
  readonly ports: { readonly clipboard: ClipboardPort };
}

export function copyCodeBlock(target: CodeBlockCopyTarget, code: string): void {
  if (!code) {
    notify(target, "Code block is empty", { key: "clipboard", durationMs: 1400 });
    return;
  }
  void target.ports.clipboard.writeText(code).then(
    () => notify(target, "Copied code block", { level: "success", key: "clipboard", durationMs: 1600 }),
    () => notify(target, "Copy failed", { level: "warn", key: "clipboard", durationMs: 2200 }),
  );
}
