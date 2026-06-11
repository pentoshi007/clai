import chalk from "chalk";

export interface ThinkingResult {
  visible: string;
  hasThinking: boolean;
  thinkContent: string;
}

let lastThinkContent = "";
let thinkingBlocks: string[] = [];
let thinkingVisible = false;

function trimBlocks(blocks: string[]): string {
  return blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join("\n\n");
}

function findOpenTag(text: string): { index: number; length: number } | undefined {
  const match = /<think\b[^>]*>/i.exec(text);
  if (!match) return undefined;
  return { index: match.index, length: match[0].length };
}

function findCloseTag(text: string): { index: number; length: number } | undefined {
  const match = /<\/think>/i.exec(text);
  if (!match) return undefined;
  return { index: match.index, length: match[0].length };
}

export function stripThinking(text: string): ThinkingResult {
  const thinkBlocks: string[] = [];
  const visible = text
    .replace(/<think\b[^>]*>([\s\S]*?)(?:<\/think>|$)/gi, (_match, content: string) => {
      thinkBlocks.push(content);
      return "";
    })
    .trim();
  const thinkContent = trimBlocks(thinkBlocks);
  return { visible, hasThinking: thinkContent.length > 0, thinkContent };
}

export function rememberThinking(content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  lastThinkContent = trimmed;
  // Keep every block of the current response so Ctrl+T can expand them all,
  // not just the most recent one. Avoid pushing an exact duplicate of the
  // previous block (some providers re-emit the same reasoning on a retry).
  if (thinkingBlocks[thinkingBlocks.length - 1] !== trimmed) {
    thinkingBlocks.push(trimmed);
  }
}

export function rememberThinkingFromText(text: string): ThinkingResult {
  const result = stripThinking(text);
  if (result.hasThinking) rememberThinking(result.thinkContent);
  return result;
}

export function clearThinking(): void {
  lastThinkContent = "";
  thinkingBlocks = [];
}

export function getLastThinking(): string {
  return lastThinkContent;
}

/** Every reasoning block captured for the current/last response, in order. */
export function getAllThinking(): string[] {
  return thinkingBlocks;
}

export function isThinkingVisible(): boolean {
  return thinkingVisible;
}

export function toggleThinkingVisibility(): boolean {
  thinkingVisible = !thinkingVisible;
  return thinkingVisible;
}

/** Terminal width, clamped to a sensible band for the thinking frame. */
function frameWidth(): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(40, Math.min(cols - 2, 100));
}

/** Soft-wrap a paragraph to `width` columns without breaking mid-word. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/g, "");
    if (line.length === 0) {
      out.push("");
      continue;
    }
    let current = "";
    for (const word of line.split(/\s+/)) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += ` ${word}`;
      } else {
        out.push(current);
        current = word;
      }
      // Hard-break a single word longer than the line width.
      while (current.length > width) {
        out.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    if (current.length > 0) out.push(current);
  }
  return out;
}

/**
 * Render one reasoning block as a framed, dimmed-italic panel. An optional
 * label (e.g. "1/3") is shown in the header so multiple blocks are
 * distinguishable when expanded together.
 */
export function renderThinkingBlock(
  content = lastThinkContent,
  label?: string,
): string {
  const width = frameWidth();
  const headerText = label ? `thinking ${label}` : "thinking";
  const header = `╭─ ${headerText} ` + "─".repeat(Math.max(0, width - headerText.length - 4));
  const footer = "╰" + "─".repeat(Math.max(0, width - 1));
  const body = wrapText(content, width - 4).map(
    (l) => chalk.dim("│ ") + chalk.dim.italic(l),
  );
  return [chalk.dim(`  ${header}`), ...body.map((l) => `  ${l}`), chalk.dim(`  ${footer}`)].join(
    "\n",
  );
}

/** Render every reasoning block of the current/last response, expanded. */
export function renderAllThinking(): string {
  const blocks = thinkingBlocks.length > 0 ? thinkingBlocks : lastThinkContent ? [lastThinkContent] : [];
  if (blocks.length === 0) return chalk.dim("  No thinking from the last response.");
  if (blocks.length === 1) return renderThinkingBlock(blocks[0]!);
  return blocks
    .map((block, i) => renderThinkingBlock(block, `${i + 1}/${blocks.length}`))
    .join("\n");
}

export function renderThinkingHiddenNotice(): string {
  return chalk.dim("  ▸ thinking collapsed — Ctrl+T to expand");
}

export function renderThinkingSummary(content: string): string {
  return thinkingVisible ? renderThinkingBlock(content) : renderThinkingHiddenNotice();
}

export function renderThinkingToggleMessage(): string {
  const visible = toggleThinkingVisibility();
  if (visible) {
    if (thinkingBlocks.length > 0 || lastThinkContent) return renderAllThinking();
    return chalk.dim("  ▾ thinking expanded — reasoning will show inline as it happens");
  }
  return chalk.dim("  ▸ thinking collapsed — reasoning hidden");
}

export function createThinkingStreamParser(
  onVisible: (text: string) => void,
  onReasoning?: (text: string) => void,
): {
  push(token: string): void;
  finish(): ThinkingResult;
} {
  let pending = "";
  let visible = "";
  let inThink = false;
  let thinkBuffer = "";
  const thinkBlocks: string[] = [];

  const emitVisible = (text: string): void => {
    if (!text) return;
    visible += text;
    onVisible(text);
  };

  const emitThinking = (text: string): void => {
    if (!text) return;
    thinkBuffer += text;
    onReasoning?.(text);
  };

  const finishThinkingBlock = (): void => {
    if (thinkBuffer.trim()) thinkBlocks.push(thinkBuffer);
    thinkBuffer = "";
  };

  const processPending = (flush: boolean): void => {
    while (pending.length > 0) {
      if (inThink) {
        const closeTag = findCloseTag(pending);
        if (closeTag) {
          emitThinking(pending.slice(0, closeTag.index));
          finishThinkingBlock();
          pending = pending.slice(closeTag.index + closeTag.length);
          inThink = false;
          continue;
        }

        if (flush) {
          emitThinking(pending);
          pending = "";
          continue;
        }

        const partialClose = pending.toLowerCase().lastIndexOf("</think");
        const safeLength = partialClose >= 0
          ? partialClose
          : Math.max(0, pending.length - "</think>".length + 1);
        if (safeLength === 0) break;
        emitThinking(pending.slice(0, safeLength));
        pending = pending.slice(safeLength);
        continue;
      }

      const openTag = findOpenTag(pending);
      if (openTag) {
        emitVisible(pending.slice(0, openTag.index));
        pending = pending.slice(openTag.index + openTag.length);
        inThink = true;
        thinkBuffer = "";
        continue;
      }

      if (flush) {
        emitVisible(pending);
        pending = "";
        continue;
      }

      const partialOpen = pending.toLowerCase().lastIndexOf("<think");
      const safeLength = partialOpen >= 0 ? partialOpen : Math.max(0, pending.length - "<think".length + 1);
      if (safeLength === 0) break;
      emitVisible(pending.slice(0, safeLength));
      pending = pending.slice(safeLength);
    }
  };

  return {
    push(token: string): void {
      pending += token;
      processPending(false);
    },
    finish(): ThinkingResult {
      processPending(true);
      if (inThink) finishThinkingBlock();
      const thinkContent = trimBlocks(thinkBlocks);
      if (thinkContent) rememberThinking(thinkContent);
      return {
        visible,
        hasThinking: thinkContent.length > 0,
        thinkContent,
      };
    },
  };
}
