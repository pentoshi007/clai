import chalk from "chalk";
import {
  REASONING_CLOSE,
  REASONING_OPEN,
  stripReasoningMarkers,
} from "../llm/reasoning-marker.js";

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
  const match = /<think(?:ing)?\b[^>]*>/i.exec(text);
  if (!match) return undefined;
  return { index: match.index, length: match[0].length };
}

function findCloseTag(text: string): { index: number; length: number } | undefined {
  const match = /<\/think(?:ing)?>/i.exec(text);
  if (!match) return undefined;
  return { index: match.index, length: match[0].length };
}

const LEGACY_TAG_PREFIX = "<thinking";

function takeMarkerBlocks(text: string, blocks: string[]): string {
  if (!text.includes(REASONING_OPEN)) return text;
  let visible = "";
  let rest = text;
  for (;;) {
    const open = rest.indexOf(REASONING_OPEN);
    if (open < 0) {
      visible += rest;
      return visible;
    }
    visible += rest.slice(0, open);
    const after = rest.slice(open + REASONING_OPEN.length);
    const close = after.indexOf(REASONING_CLOSE);
    if (close < 0) {
      blocks.push(after);
      return visible;
    }
    blocks.push(after.slice(0, close));
    rest = after.slice(close + REASONING_CLOSE.length);
  }
}

function takeLeadingLegacyBlocks(text: string, blocks: string[]): string {
  let rest = text;
  for (;;) {
    const open = findOpenTag(rest);
    if (!open || rest.slice(0, open.index).trim()) return rest;
    const after = rest.slice(open.index + open.length);
    const close = findCloseTag(after);
    if (!close) {
      blocks.push(after);
      return "";
    }
    blocks.push(after.slice(0, close.index));
    rest = after.slice(close.index + close.length);
  }
}

export function stripThinking(text: string): ThinkingResult {
  const thinkBlocks: string[] = [];
  const withoutMarkers = takeMarkerBlocks(text, thinkBlocks);
  const visible = stripReasoningMarkers(
    takeLeadingLegacyBlocks(withoutMarkers, thinkBlocks),
  ).trim();
  const thinkContent = trimBlocks(thinkBlocks);
  return { visible, hasThinking: thinkContent.length > 0, thinkContent };
}

export function rememberThinking(content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  lastThinkContent = trimmed;
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

function frameWidth(): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(40, Math.min(cols - 2, 100));
}

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
      while (current.length > width) {
        out.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    if (current.length > 0) out.push(current);
  }
  return out;
}

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

export interface ThinkingStreamOptions {
  remember?: boolean | undefined;
}

export function createThinkingStreamParser(
  onVisible: (text: string) => void,
  onReasoning?: (text: string) => void,
  options: ThinkingStreamOptions = {},
): {
  push(token: string): void;
  finish(): ThinkingResult;
} {
  let pending = "";
  let visible = "";
  let inThink = false;
  let legacyRegion = false;
  let sawVisible = false;
  let thinkBuffer = "";
  const thinkBlocks: string[] = [];

  const emitVisible = (text: string): void => {
    if (!text) return;
    const clean = stripReasoningMarkers(text);
    if (!clean) return;
    if (clean.trim()) sawVisible = true;
    visible += clean;
    onVisible(clean);
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

  const leadingLegacyTag = (
    text: string,
  ): { index: number; length: number } | undefined => {
    if (sawVisible) return undefined;
    const tag = findOpenTag(text);
    if (!tag || text.slice(0, tag.index).trim()) return undefined;
    return tag;
  };

  const mayStillOpenLegacyTag = (text: string): boolean => {
    if (sawVisible) return false;
    const trimmed = text.replace(/^\s+/, "");
    if (!trimmed) return true;
    if (LEGACY_TAG_PREFIX.startsWith(trimmed.toLowerCase())) return true;
    return /^<think(?:ing)?\b[^>]*$/i.test(trimmed);
  };

  const processPending = (flush: boolean): void => {
    for (;;) {
      if (pending.length === 0) return;
      if (inThink) {
        let closeIndex = pending.indexOf(REASONING_CLOSE);
        let closeLength = closeIndex >= 0 ? REASONING_CLOSE.length : 0;
        if (legacyRegion) {
          const closeTag = findCloseTag(pending);
          if (closeTag && (closeIndex < 0 || closeTag.index < closeIndex)) {
            closeIndex = closeTag.index;
            closeLength = closeTag.length;
          }
        }
        if (closeIndex >= 0) {
          emitThinking(pending.slice(0, closeIndex));
          finishThinkingBlock();
          pending = pending.slice(closeIndex + closeLength);
          inThink = false;
          legacyRegion = false;
          continue;
        }
        if (flush || !legacyRegion) {
          emitThinking(pending);
          pending = "";
          if (flush) continue;
          return;
        }
        const partialClose = pending.toLowerCase().lastIndexOf("</think");
        const safeLength =
          partialClose >= 0
            ? partialClose
            : Math.max(0, pending.length - "</thinking>".length + 1);
        if (safeLength === 0) return;
        emitThinking(pending.slice(0, safeLength));
        pending = pending.slice(safeLength);
        return;
      }

      let openIndex = pending.indexOf(REASONING_OPEN);
      let openLength = openIndex >= 0 ? REASONING_OPEN.length : 0;
      let legacy = false;
      const legacyTag = leadingLegacyTag(pending);
      if (legacyTag && (openIndex < 0 || legacyTag.index < openIndex)) {
        openIndex = legacyTag.index;
        openLength = legacyTag.length;
        legacy = true;
      }
      if (openIndex >= 0) {
        emitVisible(pending.slice(0, openIndex));
        pending = pending.slice(openIndex + openLength);
        inThink = true;
        legacyRegion = legacy;
        thinkBuffer = "";
        continue;
      }

      if (flush) {
        emitVisible(pending);
        pending = "";
        continue;
      }
      if (mayStillOpenLegacyTag(pending)) return;
      emitVisible(pending);
      pending = "";
      return;
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
      if (thinkContent && options.remember !== false) {
        rememberThinking(thinkContent);
      }
      return {
        visible,
        hasThinking: thinkContent.length > 0,
        thinkContent,
      };
    },
  };
}
