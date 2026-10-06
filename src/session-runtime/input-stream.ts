const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_SEQUENCE_BYTES = 4 * 1024;

export class RuntimeInputStream {
  private pending = "";
  private pasting = false;
  private stringReply = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private outputTail = "";
  private cursorReplies = 0;

  constructor(private readonly receive: (bytes: Buffer, reply: boolean) => void) {}

  observeOutput(bytes: Uint8Array): void {
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!this.outputTail.includes(ESC) && chunk.indexOf(0x1b) < 0) return;
    const text = this.outputTail + chunk.toString("latin1");
    for (const match of text.matchAll(/\x1b\[\??6n/g)) {
      if (match.index + match[0].length > this.outputTail.length) this.cursorReplies = Math.min(16, this.cursorReplies + 1);
    }
    this.outputTail = text.slice(-5);
  }

  push(bytes: Uint8Array): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending += Buffer.from(bytes).toString("latin1");
    this.drain();
    if ((this.pending && !this.pasting) || this.stringReply) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const pending = this.pending;
        this.pending = "";
        const reply = this.stringReply;
        this.stringReply = false;
        if (pending) this.receive(Buffer.from(pending, "latin1"), reply);
      }, 50);
      this.timer.unref?.();
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = "";
    this.stringReply = false;
  }

  private emit(length: number, reply = false): void {
    const text = this.pending.slice(0, length);
    this.pending = this.pending.slice(length);
    this.receive(Buffer.from(text, "latin1"), reply);
  }

  private drain(): void {
    while (this.pending) {
      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END);
        if (end >= 0) {
          this.emit(end + PASTE_END.length);
          this.pasting = false;
          continue;
        }
        let keep = Math.min(PASTE_END.length - 1, this.pending.length);
        while (keep > 0 && !PASTE_END.startsWith(this.pending.slice(-keep))) keep -= 1;
        if (this.pending.length > keep) this.emit(this.pending.length - keep);
        return;
      }
      if (this.stringReply) {
        const bel = this.pending.indexOf("\x07");
        const st = this.pending.indexOf("\x1b\\");
        const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : -1;
        if (end >= 0) {
          this.emit(end, true);
          this.stringReply = false;
          continue;
        }
        const keep = this.pending.endsWith(ESC) ? 1 : 0;
        if (this.pending.length > keep) this.emit(this.pending.length - keep, true);
        return;
      }
      if (!this.pending.startsWith(ESC)) {
        const next = this.pending.indexOf(ESC);
        this.emit(next < 0 ? this.pending.length : next);
        continue;
      }
      if (this.pending.length === 1) return;
      const starter = this.pending[1];
      if (starter === "[") {
        const sequence = /^\x1b\[[\x20-\x3f]*[\x40-\x7e]/.exec(this.pending)?.[0];
        if (!sequence) {
          if (this.pending.length <= MAX_SEQUENCE_BYTES && /^\x1b\[[\x20-\x3f]*$/.test(this.pending)) return;
          this.emit(1);
          continue;
        }
        if (sequence === PASTE_START) this.pasting = true;
        const cursor = /^\x1b\[\??\d+;\d+R$/.test(sequence);
        const modifiedF3 = /^\x1b\[1;(?:[2-9]|1[0-6])R$/.test(sequence);
        const cursorReply = cursor && (this.cursorReplies > 0 || !modifiedF3);
        if (cursorReply && this.cursorReplies > 0) this.cursorReplies -= 1;
        const reply = cursorReply || /^\x1b\[[?>=]?[\d;:]*c$/.test(sequence) ||
          /^\x1b\[\??[\d;]*n$/.test(sequence) || /^\x1b\[\d+(?:;\d+)+t$/.test(sequence) ||
          /^\x1b\[\?[\d;]+(?:u|\$y)$/.test(sequence) || /^\x1b\[[IO]$/.test(sequence) ||
          /^\x1b\[[\d:]+;[\d]+:3u$/.test(sequence);
        this.emit(sequence.length, reply);
        continue;
      }
      if (starter && "]P_^X".includes(starter)) {
        this.stringReply = true;
        continue;
      }
      if (starter === "O" && this.pending.length < 3) return;
      this.emit(starter === "O" ? 3 : 2);
    }
  }
}
