export const DEFAULT_READ_MAX_BYTES = 8 * 1024 * 1024;

export function clipReadText(text: string, maxBytes: number): string {
  const candidate = text.slice(0, maxBytes);
  if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  const buffer = Buffer.from(candidate, "utf8");
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

export class ReadOutputBudget {
  private remaining: number;
  truncated = false;

  constructor(maxBytes = DEFAULT_READ_MAX_BYTES) {
    this.remaining = maxBytes;
  }

  take(line: string): string | undefined {
    if (this.remaining < 1) {
      this.truncated = true;
      return undefined;
    }
    const text = clipReadText(line, this.remaining - 1);
    this.remaining -= Buffer.byteLength(text, "utf8") + 1;
    if (text !== line) this.truncated = true;
    return text;
  }
}
