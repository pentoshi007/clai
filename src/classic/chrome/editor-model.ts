const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export interface EditorState {
  readonly text: string;
  readonly cursor: number;
}

export const EMPTY_EDITOR: EditorState = { text: "", cursor: 0 };

export function boundaries(text: string): number[] {
  const out = [0];
  for (const part of segmenter.segment(text)) {
    const end = part.index + part.segment.length;
    if (end > out[out.length - 1]!) out.push(end);
  }
  if (out[out.length - 1] !== text.length) out.push(text.length);
  return out;
}

function clampToBoundary(text: string, offset: number): number {
  const bounds = boundaries(text);
  const target = Math.max(0, Math.min(offset, text.length));
  let best = 0;
  for (const bound of bounds) {
    if (bound <= target) best = bound;
    else break;
  }
  return best;
}

export function normalize(state: EditorState): EditorState {
  const cursor = clampToBoundary(state.text, state.cursor);
  return cursor === state.cursor ? state : { text: state.text, cursor };
}

export function prevBoundary(text: string, offset: number): number {
  const bounds = boundaries(text);
  let prev = 0;
  for (const bound of bounds) {
    if (bound >= offset) break;
    prev = bound;
  }
  return prev;
}

export function nextBoundary(text: string, offset: number): number {
  for (const bound of boundaries(text)) {
    if (bound > offset) return bound;
  }
  return text.length;
}

export function insert(state: EditorState, value: string): EditorState {
  if (value.length === 0) return state;
  const at = clampToBoundary(state.text, state.cursor);
  return {
    text: `${state.text.slice(0, at)}${value}${state.text.slice(at)}`,
    cursor: at + value.length,
  };
}

export function deleteBackward(state: EditorState): EditorState {
  const at = clampToBoundary(state.text, state.cursor);
  if (at === 0) return state;
  const from = prevBoundary(state.text, at);
  return { text: `${state.text.slice(0, from)}${state.text.slice(at)}`, cursor: from };
}

export function deleteForward(state: EditorState): EditorState {
  const at = clampToBoundary(state.text, state.cursor);
  if (at >= state.text.length) return state;
  const to = nextBoundary(state.text, at);
  return { text: `${state.text.slice(0, at)}${state.text.slice(to)}`, cursor: at };
}

export function moveLeft(state: EditorState): EditorState {
  const at = clampToBoundary(state.text, state.cursor);
  return { text: state.text, cursor: at === 0 ? 0 : prevBoundary(state.text, at) };
}

export function moveRight(state: EditorState): EditorState {
  const at = clampToBoundary(state.text, state.cursor);
  return { text: state.text, cursor: nextBoundary(state.text, at) };
}

const WORD = /[\p{L}\p{N}_]/u;

export function wordStartBefore(text: string, offset: number): number {
  let at = offset;
  while (at > 0 && !WORD.test(text[at - 1] ?? "")) at = prevBoundary(text, at);
  while (at > 0 && WORD.test(text[at - 1] ?? "")) at = prevBoundary(text, at);
  return at;
}

export function wordEndAfter(text: string, offset: number): number {
  let at = offset;
  while (at < text.length && !WORD.test(text[at] ?? "")) at = nextBoundary(text, at);
  while (at < text.length && WORD.test(text[at] ?? "")) at = nextBoundary(text, at);
  return at;
}

export function moveWordLeft(state: EditorState): EditorState {
  return { text: state.text, cursor: wordStartBefore(state.text, clampToBoundary(state.text, state.cursor)) };
}

export function moveWordRight(state: EditorState): EditorState {
  return { text: state.text, cursor: wordEndAfter(state.text, clampToBoundary(state.text, state.cursor)) };
}

export function deleteWordBackward(state: EditorState): EditorState {
  const at = clampToBoundary(state.text, state.cursor);
  const from = wordStartBefore(state.text, at);
  if (from === at) return state;
  return { text: `${state.text.slice(0, from)}${state.text.slice(at)}`, cursor: from };
}

export function deleteWordForward(state: EditorState): EditorState {
  const at = clampToBoundary(state.text, state.cursor);
  const to = wordEndAfter(state.text, at);
  if (to === at) return state;
  return { text: `${state.text.slice(0, at)}${state.text.slice(to)}`, cursor: at };
}

export function lineStart(text: string, offset: number): number {
  const at = text.lastIndexOf("\n", Math.max(0, offset - 1));
  return at === -1 ? 0 : at + 1;
}

export function lineEnd(text: string, offset: number): number {
  const at = text.indexOf("\n", offset);
  return at === -1 ? text.length : at;
}

export function moveLineStart(state: EditorState): EditorState {
  return { text: state.text, cursor: lineStart(state.text, state.cursor) };
}

export function moveLineEnd(state: EditorState): EditorState {
  return { text: state.text, cursor: lineEnd(state.text, state.cursor) };
}

export function moveBufferStart(state: EditorState): EditorState {
  return { text: state.text, cursor: 0 };
}

export function moveBufferEnd(state: EditorState): EditorState {
  return { text: state.text, cursor: state.text.length };
}

export function deleteToLineStart(state: EditorState): EditorState {
  const at = clampToBoundary(state.text, state.cursor);
  const from = lineStart(state.text, at);
  if (from === at) return state;
  return { text: `${state.text.slice(0, from)}${state.text.slice(at)}`, cursor: from };
}

export function deleteToLineEnd(state: EditorState): EditorState {
  const at = clampToBoundary(state.text, state.cursor);
  const to = lineEnd(state.text, at);
  if (to === at) return state;
  return { text: `${state.text.slice(0, at)}${state.text.slice(to)}`, cursor: at };
}

export function deleteLine(state: EditorState): EditorState {
  const at = clampToBoundary(state.text, state.cursor);
  const from = lineStart(state.text, at);
  const to = lineEnd(state.text, at);
  if (from === 0 && to === state.text.length) return { text: "", cursor: 0 };
  if (to === state.text.length) return { text: state.text.slice(0, from === 0 ? 0 : from - 1), cursor: from === 0 ? 0 : from - 1 };
  const after = state.text[to] === "\n" ? to + 1 : to;
  return { text: `${state.text.slice(0, from)}${state.text.slice(after)}`, cursor: from };
}

export function setText(state: EditorState, text: string): EditorState {
  return normalize({ text, cursor: Math.min(state.cursor, text.length) });
}

export function replaceRange(
  state: EditorState,
  start: number,
  end: number,
  value: string,
): EditorState {
  const from = Math.max(0, Math.min(start, state.text.length));
  const to = Math.max(from, Math.min(end, state.text.length));
  return {
    text: `${state.text.slice(0, from)}${value}${state.text.slice(to)}`,
    cursor: from + value.length,
  };
}

export function logicalLines(text: string): string[] {
  return text.split("\n");
}

export function caretPosition(state: EditorState): { line: number; column: number } {
  const before = state.text.slice(0, clampToBoundary(state.text, state.cursor));
  const lines = before.split("\n");
  const column = boundaries(lines[lines.length - 1] ?? "").length - 1;
  return { line: lines.length - 1, column };
}

function offsetForColumn(line: string, column: number): number {
  const bounds = boundaries(line);
  return bounds[Math.min(column, bounds.length - 1)] ?? line.length;
}

export function moveLine(state: EditorState, delta: number): EditorState {
  const lines = logicalLines(state.text);
  const { line, column } = caretPosition(state);
  const target = line + delta;
  if (target < 0 || target >= lines.length) return state;
  let offset = 0;
  for (let index = 0; index < target; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return { text: state.text, cursor: offset + offsetForColumn(lines[target] ?? "", column) };
}
