import chalk from "chalk";

// Lightweight terminal markdown renderer that styles **bold**, *italic*,
// `code`, links, headings, lists, blockquotes, hrules, and ```fenced```
// code blocks. Designed to work both for one-shot strings and for
// token-streaming inputs (line-buffered).

const FENCE_OPEN = chalk.dim;
const FENCE_LINE = chalk.cyan;

function repeat(char: string, count: number): string {
  return char.repeat(Math.max(0, count));
}

function renderFenceHeader(lang: string, width = 60): string {
  const label = lang || "code";
  const head = `─── ${label} `;
  return FENCE_OPEN(head + repeat("─", Math.max(0, width - head.length)));
}

function renderFenceFooter(width = 60): string {
  return FENCE_OPEN(repeat("─", width));
}

// Walk inline markdown tokens and convert them to ANSI styles. Designed to
// handle one logical line at a time (so it can run after a newline arrives
// in the token stream).
export function renderInlineMarkdown(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    // ``code`` (longer fences first to avoid eating the inner ticks)
    if (text.startsWith("``", i)) {
      const end = text.indexOf("``", i + 2);
      if (end > i + 2) {
        out += chalk.cyan(`\`${text.slice(i + 2, end)}\``);
        i = end + 2;
        continue;
      }
    }

    // `code`
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        out += chalk.cyan(text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }

    // ***bold-italic***
    if (text.startsWith("***", i)) {
      const end = text.indexOf("***", i + 3);
      if (end > i + 3) {
        out += chalk.bold.italic(renderInlineMarkdown(text.slice(i + 3, end)));
        i = end + 3;
        continue;
      }
    }

    // **bold**
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        out += chalk.bold(renderInlineMarkdown(text.slice(i + 2, end)));
        i = end + 2;
        continue;
      }
    }

    // __bold__
    if (text.startsWith("__", i)) {
      const end = text.indexOf("__", i + 2);
      if (end > i + 2) {
        out += chalk.bold(renderInlineMarkdown(text.slice(i + 2, end)));
        i = end + 2;
        continue;
      }
    }

    // *italic* — only when surrounded by non-word boundaries to avoid
    // chewing through `*` characters in code or maths.
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1 && text[end + 1] !== "*") {
        const inner = text.slice(i + 1, end);
        if (inner.length > 0 && !inner.startsWith(" ") && !inner.endsWith(" ")) {
          out += chalk.italic(renderInlineMarkdown(inner));
          i = end + 1;
          continue;
        }
      }
    }

    // _italic_ (skip if it looks like part of a snake_case word)
    if (text[i] === "_") {
      const prev = text[i - 1];
      const isWordBoundary = !prev || /[\s\W]/.test(prev);
      if (isWordBoundary) {
        const end = text.indexOf("_", i + 1);
        if (end > i + 1) {
          const after = text[end + 1];
          const isAfterBoundary = !after || /[\s\W]/.test(after);
          const inner = text.slice(i + 1, end);
          if (
            isAfterBoundary &&
            inner.length > 0 &&
            !inner.startsWith(" ") &&
            !inner.endsWith(" ")
          ) {
            out += chalk.italic(renderInlineMarkdown(inner));
            i = end + 1;
            continue;
          }
        }
      }
    }

    // ~~strike~~
    if (text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 2) {
        out += chalk.strikethrough(renderInlineMarkdown(text.slice(i + 2, end)));
        i = end + 2;
        continue;
      }
    }

    // [label](url)
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close + 2) {
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, urlEnd);
          out += chalk.cyan.underline(label) + chalk.dim(`(${url})`);
          i = urlEnd + 1;
          continue;
        }
      }
    }

    out += text[i];
    i += 1;
  }
  return out;
}

interface BlockState {
  inFence: boolean;
  fenceLang: string;
}

function renderBlockLine(line: string, state: BlockState): string {
  // Code fence open/close
  const fenceMatch = line.match(/^(\s*)```(\w*)\s*(.*)$/);
  if (fenceMatch) {
    if (state.inFence) {
      state.inFence = false;
      state.fenceLang = "";
      return renderFenceFooter();
    }
    state.inFence = true;
    state.fenceLang = fenceMatch[2] ?? "";
    return renderFenceHeader(state.fenceLang);
  }

  if (state.inFence) {
    return FENCE_LINE(line);
  }

  // Headings
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = heading[1]!.length;
    const body = heading[2]!.trim();
    if (level <= 2) return chalk.bold.magenta(renderInlineMarkdown(body));
    if (level === 3) return chalk.bold.cyan(renderInlineMarkdown(body));
    return chalk.bold(renderInlineMarkdown(body));
  }

  // Horizontal rule
  if (/^\s*[-*_]{3,}\s*$/.test(line)) {
    return chalk.dim(repeat("─", 60));
  }

  // Markdown table separator: | --- | --- |
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
    return chalk.dim(repeat("─", Math.max(20, line.length)));
  }

  // Markdown table row: | cell | cell |
  if (/^\s*\|.*\|\s*$/.test(line)) {
    const cells = line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => renderInlineMarkdown(cell.trim()));
    return chalk.dim("│ ") + cells.join(chalk.dim(" │ ")) + chalk.dim(" │");
  }

  // Blockquote
  if (line.startsWith("> ")) {
    return chalk.dim("│ ") + chalk.dim.italic(renderInlineMarkdown(line.slice(2)));
  }

  // GitHub-style task list: - [ ] todo  /  - [x] done
  const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const checked = /[xX]/.test(task[2]!);
    const box = checked ? chalk.green("☑") : chalk.dim("☐");
    const body = renderInlineMarkdown(task[3]!);
    return `${task[1]}${box} ${checked ? chalk.dim(body) : body}`;
  }

  // Ordered list
  const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ordered) {
    return `${ordered[1]}${chalk.cyan(`${ordered[2]}.`)} ${renderInlineMarkdown(ordered[3]!)}`;
  }

  // Unordered list
  const unordered = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (unordered) {
    return `${unordered[1]}${chalk.cyan("•")} ${renderInlineMarkdown(unordered[2]!)}`;
  }

  return renderInlineMarkdown(line);
}

/** Left margin for all rendered output so text doesn't go edge-to-edge. */
const OUTPUT_INDENT = "  ";

function stripAnsi(str: string): string {
  // biome-ignore lint: escape sequences are intentional
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function wrapAnsiLine(line: string, maxWidth: number): string[] {
  const visibleLength = stripAnsi(line).length;
  if (visibleLength <= maxWidth) return [line];

  const tokens: { type: "space" | "ansi" | "char"; value: string }[] = [];
  let i = 0;
  while (i < line.length) {
    if (line.startsWith("\x1b[", i)) {
      let j = i + 2;
      while (j < line.length && !/[a-zA-Z]/.test(line[j]!)) {
        j++;
      }
      const val = line.slice(i, j + 1);
      tokens.push({ type: "ansi", value: val });
      i = j + 1;
    } else if (/\s/.test(line[i]!)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j]!)) {
        j++;
      }
      tokens.push({ type: "space", value: line.slice(i, j) });
      i = j;
    } else {
      tokens.push({ type: "char", value: line[i]! });
      i++;
    }
  }

  const words: { text: string; visibleLength: number }[] = [];
  let currentWord = "";
  let currentWordVisibleLength = 0;

  for (const token of tokens) {
    if (token.type === "space") {
      if (currentWord) {
        words.push({ text: currentWord, visibleLength: currentWordVisibleLength });
        currentWord = "";
        currentWordVisibleLength = 0;
      }
      words.push({ text: " ", visibleLength: 0 });
    } else {
      currentWord += token.value;
      if (token.type === "char") {
        currentWordVisibleLength += 1;
      }
    }
  }
  if (currentWord) {
    words.push({ text: currentWord, visibleLength: currentWordVisibleLength });
  }

  const lines: string[] = [];
  let currentLineText = "";
  let currentLineVisibleLength = 0;

  for (const word of words) {
    if (word.text === " ") {
      if (currentLineVisibleLength > 0) {
        currentLineText += " ";
        currentLineVisibleLength += 1;
      }
      continue;
    }

    if (currentLineVisibleLength === 0) {
      currentLineText = word.text;
      currentLineVisibleLength = word.visibleLength;
    } else if (currentLineVisibleLength + word.visibleLength <= maxWidth) {
      currentLineText += word.text;
      currentLineVisibleLength += word.visibleLength;
    } else {
      lines.push(currentLineText);
      currentLineText = word.text;
      currentLineVisibleLength = word.visibleLength;
    }
  }
  if (currentLineVisibleLength > 0) {
    lines.push(currentLineText);
  }

  return lines.length > 0 ? lines : [line];
}

export function indentAndWrapText(text: string, indent = "  "): string {
  if (!text) return text;
  const cols = process.stdout.columns || 80;
  const wrapWidth = Math.max(40, cols - 6);
  return text
    .split("\n")
    .map((line) => {
      const wrapped = wrapAnsiLine(line, wrapWidth);
      return wrapped.map((wl) => `${indent}${wl}`).join("\n");
    })
    .join("\n");
}

function isParagraph(line: string, inFence: boolean): boolean {
  if (inFence) return false;
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^(\s*)```/.test(line)) return false;
  if (/^(#{1,6})\s+/.test(line)) return false;
  if (/^\s*[-*_]{3,}\s*$/.test(line)) return false;
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) return false;
  if (/^\s*\|.*\|\s*$/.test(line)) return false;
  if (line.startsWith("> ")) return false;
  if (/^(\s*)[-*+]\s+\[([ xX])\]\s+/.test(line)) return false;
  if (/^(\s*)(\d+)\.\s+/.test(line)) return false;
  if (/^(\s*)[-*+]\s+/.test(line)) return false;
  return true;
}

export function renderMarkdown(text: string): string {
  if (!text) return text;
  const state: BlockState = { inFence: false, fenceLang: "" };
  const lines = text.split("\n");
  const resultLines: string[] = [];

  const cols = process.stdout.columns || 80;
  const wrapWidth = Math.max(40, cols - 6);

  for (const line of lines) {
    if (isParagraph(line, state.inFence)) {
      const wrapped = wrapAnsiLine(line, wrapWidth);
      for (const wl of wrapped) {
        resultLines.push(`${OUTPUT_INDENT}${renderBlockLine(wl, state)}`);
      }
    } else {
      resultLines.push(`${OUTPUT_INDENT}${renderBlockLine(line, state)}`);
    }
  }
  return resultLines.join("\n");
}

// Streaming variant: buffers tokens and emits ANSI-rendered output
// whenever a complete line arrives. Inside a fenced code block, lines
// are emitted as cyan text with header/footer borders.
export function createMarkdownStreamWriter(write: (chunk: string) => void): {
  push(token: string): void;
  finish(): void;
} {
  const state: BlockState = { inFence: false, fenceLang: "" };
  let buffer = "";

  const cols = process.stdout.columns || 80;
  const wrapWidth = Math.max(40, cols - 6);

  const emitLine = (line: string, withNewline: boolean): void => {
    if (isParagraph(line, state.inFence)) {
      const wrapped = wrapAnsiLine(line, wrapWidth);
      wrapped.forEach((wl, idx) => {
        write(`${OUTPUT_INDENT}${renderBlockLine(wl, state)}`);
        if (withNewline || idx < wrapped.length - 1) write("\n");
      });
    } else {
      write(`${OUTPUT_INDENT}${renderBlockLine(line, state)}`);
      if (withNewline) write("\n");
    }
  };

  return {
    push(token: string): void {
      buffer += token;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        emitLine(line, true);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    finish(): void {
      if (buffer.length > 0) {
        emitLine(buffer, false);
        buffer = "";
      }
      if (state.inFence) {
        // Emit a closing rule so unterminated fences still look tidy.
        write("\n" + renderFenceFooter());
      }
    },
  };
}

