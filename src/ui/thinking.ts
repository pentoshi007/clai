import chalk from "chalk";

export interface ThinkingResult {
  visible: string;
  hasThinking: boolean;
  thinkContent: string;
}

let lastThinkContent = "";
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
  if (trimmed) lastThinkContent = trimmed;
}

export function rememberThinkingFromText(text: string): ThinkingResult {
  const result = stripThinking(text);
  if (result.hasThinking) rememberThinking(result.thinkContent);
  return result;
}

export function clearThinking(): void {
  lastThinkContent = "";
}

export function getLastThinking(): string {
  return lastThinkContent;
}

export function isThinkingVisible(): boolean {
  return thinkingVisible;
}

export function toggleThinkingVisibility(): boolean {
  thinkingVisible = !thinkingVisible;
  return thinkingVisible;
}

export function renderThinkingBlock(content = lastThinkContent): string {
  return [
    chalk.dim("--- thinking -----------------------------------"),
    chalk.dim(content),
    chalk.dim("-----------------------------------------------"),
  ].join("\n");
}

export function renderThinkingHiddenNotice(): string {
  return chalk.dim("  [thinking hidden - Ctrl+T to show]");
}

export function renderThinkingSummary(content: string): string {
  return thinkingVisible ? renderThinkingBlock(content) : renderThinkingHiddenNotice();
}

export function renderThinkingToggleMessage(): string {
  const visible = toggleThinkingVisibility();
  if (lastThinkContent && visible) return renderThinkingBlock(lastThinkContent);
  if (lastThinkContent) return chalk.dim("  thinking hidden");
  return chalk.dim(`  thinking ${visible ? "will be shown" : "will be hidden"}`);
}

export function createThinkingStreamParser(onVisible: (text: string) => void): {
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
