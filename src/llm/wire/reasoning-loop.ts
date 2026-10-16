export const REASONING_LOOP_WINDOW_CHARS = 4_096;
const MIN_REPETITIONS = 32;
const CHECK_INTERVAL_CHARS = 128;

function hasRepetitiveReasoningSuffix(tail: string): boolean {
  const prefixes = new Uint16Array(tail.length);
  let matched = 0;
  for (let index = 1; index < tail.length; index += 1) {
    while (matched > 0 && tail[index] !== tail[matched]) {
      matched = prefixes[matched - 1]!;
    }
    if (tail[index] === tail[matched]) matched += 1;
    prefixes[index] = matched;
  }
  const period = tail.length - prefixes[tail.length - 1]!;
  return period <= tail.length / MIN_REPETITIONS;
}

export class ReasoningLoopGuard {
  private tail = "";
  private uncheckedChars = 0;

  append(text: string): boolean {
    this.tail = (this.tail + text).slice(-REASONING_LOOP_WINDOW_CHARS);
    this.uncheckedChars += text.length;
    if (this.tail.length < REASONING_LOOP_WINDOW_CHARS || this.uncheckedChars < CHECK_INTERVAL_CHARS) return false;
    this.uncheckedChars = 0;
    return hasRepetitiveReasoningSuffix(this.tail);
  }

  reset(): void {
    this.tail = "";
    this.uncheckedChars = 0;
  }
}
