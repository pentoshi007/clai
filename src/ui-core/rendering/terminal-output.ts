import { sanitizeDisplayText } from "./sanitize-display.js";

export interface TerminalOutputView {
  readonly body: readonly string[];
  readonly metadata: readonly string[];
}

const FRAME_HEADER = /^\[terminal\.(?:start|send|read|status|list|close|resize)\] /;
const LEGACY_SEND = /^seq=\d+ delivery=(?:delivered|not-delivered|unknown) bytes=\d+ state=\w+$/;
const CURSOR_LINE = /^\[cursor .+\]$/;

export function terminalOutputView(raw: string, toolName: string): TerminalOutputView | undefined {
  if (!toolName.startsWith("terminal.")) return undefined;
  const lines = sanitizeDisplayText(raw).split("\n");
  const metadata: string[] = [];
  const head = lines[0] ?? "";
  const framed = FRAME_HEADER.test(head);
  if (framed) {
    metadata.push(lines.shift()!.replace(FRAME_HEADER, ""));
  } else if (LEGACY_SEND.test(head) || /^state=\w+$/.test(head)) {
    metadata.push(lines.shift()!);
  } else if (toolName === "terminal.start" && /^session its_\S+ /.test(head)) {
    metadata.push(lines.shift()!);
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (toolName === "terminal.start" && /^artifact=/.test(lines.at(-1) ?? "")) lines.pop();
  const pageStart = lines.findIndex(line => /^\[terminal\.output cursor=/.test(line));
  const pageEnd = lines.lastIndexOf("[/terminal.output]");
  if (framed && pageStart >= 0 && pageEnd > pageStart) {
    metadata.push(lines[pageStart]!.replace(/^\[terminal\.output /, "").replace(/\]$/, ""));
    lines.splice(pageEnd, 1);
    lines.splice(pageStart, 1);
  } else if (CURSOR_LINE.test(lines.at(-1) ?? "")) {
    metadata.push(lines.pop()!.slice(1, -1));
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return { body: lines, metadata };
}

export function terminalOutputLines(raw: string, toolName: string): readonly string[] | undefined {
  const view = terminalOutputView(raw, toolName);
  if (!view) return undefined;
  return [...view.body, ...view.metadata];
}
