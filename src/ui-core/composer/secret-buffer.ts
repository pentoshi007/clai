/**
 * Masked secret editor state (INPUT-009, V2-046).
 *
 * The raw value never surfaces through the normal getters, string coercion,
 * or JSON serialization used everywhere else in the app (transcript,
 * history, logs) — only `reveal()` returns it, so a secret can only leave
 * this buffer through the one call site that explicitly asks for it.
 */

const MASK_CHAR = "•";

export class SecretBuffer {
  private value = "";

  insert(text: string, cursorOffset: number): number {
    this.value = this.value.slice(0, cursorOffset) + text + this.value.slice(cursorOffset);
    return cursorOffset + text.length;
  }

  deleteBackward(cursorOffset: number): number {
    if (cursorOffset <= 0) return cursorOffset;
    this.value = this.value.slice(0, cursorOffset - 1) + this.value.slice(cursorOffset);
    return cursorOffset - 1;
  }

  clear(): void {
    this.value = "";
  }

  get length(): number {
    return this.value.length;
  }

  masked(): string {
    return MASK_CHAR.repeat(this.value.length);
  }

  /** The only sanctioned way to read the plaintext back out. */
  reveal(): string {
    return this.value;
  }

  toString(): string {
    return this.masked();
  }

  toJSON(): string {
    return this.masked();
  }
}
