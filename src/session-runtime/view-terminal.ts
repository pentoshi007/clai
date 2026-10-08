import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { TerminalDimensions } from "../interactive-session/types.js";

export class RuntimeViewInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  setRawMode(mode: boolean): this { this.isRaw = mode; return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}

export class RuntimeViewOutput extends Writable {
  readonly isTTY = true;
  columns: number;
  rows: number;

  constructor(dimensions: TerminalDimensions, private readonly send: (bytes: Uint8Array) => boolean) {
    super();
    this.columns = dimensions.columns;
    this.rows = dimensions.rows;
  }

  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    done(this.send(bytes) ? undefined : new Error("terminal attachment closed"));
  }

  resize(dimensions: TerminalDimensions): void {
    if (this.columns === dimensions.columns && this.rows === dimensions.rows) return;
    this.columns = dimensions.columns;
    this.rows = dimensions.rows;
    this.emit("SIGWINCH");
    this.emit("resize");
  }

  getWindowSize(): [number, number] { return [this.columns, this.rows]; }
  getColorDepth(): number { return 24; }
  hasColors(): boolean { return true; }
}

export class RuntimeViewTerminal extends EventEmitter {
  readonly stdin = new RuntimeViewInput();
  readonly stdout: RuntimeViewOutput;

  constructor(dimensions: TerminalDimensions, send: (bytes: Uint8Array) => boolean) {
    super();
    this.stdout = new RuntimeViewOutput(dimensions, send);
  }

  resize(dimensions: TerminalDimensions): void { this.stdout.resize(dimensions); }
  dispose(): void {
    this.emit("exit", 0);
    this.stdin.destroy();
    this.stdout.destroy();
    this.removeAllListeners();
  }
}
