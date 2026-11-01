export type SgrState = ReadonlyMap<number, string>;

const ATTRIBUTES = new Map([
  [3, 23], [4, 24], [5, 25], [6, 25], [7, 27],
  [8, 28], [9, 29], [21, 24], [53, 55],
]);
const RESETS = new Set([23, 24, 25, 27, 28, 29, 39, 49, 55, 59]);

function colorLength(codes: readonly number[], index: number): number {
  const mode = codes[index + 1];
  const length = mode === 5 ? 3 : mode === 2 ? 5 : 0;
  if (length === 0 || index + length > codes.length) return 0;
  const channels = codes.slice(index + 2, index + length);
  return channels.every((channel) => channel >= 0 && channel <= 255) ? length : 0;
}

function applyAttribute(state: Map<number, string>, code: number): boolean {
  if (code === 1 || code === 2) {
    const intensity = state.get(22) ?? "";
    state.set(22, [1, 2].filter((value) => value === code || intensity.includes(String(value))).join(";"));
    return true;
  }
  if (code === 22) {
    state.delete(22);
    return true;
  }
  const reset = ATTRIBUTES.get(code);
  if (reset !== undefined) state.set(reset, String(code));
  else if (RESETS.has(code)) state.delete(code);
  else return false;
  return true;
}

function applyColor(state: Map<number, string>, code: number): boolean {
  if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.set(39, String(code));
  else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.set(49, String(code));
  else return false;
  return true;
}

export function applySgr(state: SgrState | undefined, body: string): SgrState | undefined {
  if (!/^[\d;]*$/.test(body)) return undefined;
  const codes = body.split(";").map(Number);
  let next = state === undefined ? undefined : new Map(state);
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]!;
    if (code === 0) {
      next = new Map();
      continue;
    }
    if (code === 38 || code === 48 || code === 58) {
      const length = colorLength(codes, index);
      if (length === 0) return undefined;
      next?.set(code + 1, codes.slice(index, index + length).join(";"));
      index += length - 1;
      continue;
    }
    if (next === undefined) continue;
    if (!applyColor(next, code) && !applyAttribute(next, code)) return undefined;
  }
  return next;
}

export function sgrDifference(previous: SgrState, next: SgrState): string {
  const codes: string[] = [];
  for (const [reset, value] of previous) {
    if (!next.has(reset) || (reset === 22 && value !== next.get(reset))) codes.push(String(reset));
  }
  for (const [reset, value] of next) {
    if (value !== previous.get(reset)) codes.push(value);
  }
  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}
