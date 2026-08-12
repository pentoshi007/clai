export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
export const CLEAR_SCREEN = "\x1b[2J\x1b[H";

export const ALT_SCREEN_ON = "\x1b[?1049h";
export const ALT_SCREEN_OFF = "\x1b[?1049l";
export const CLEAR_SCREEN_ONLY = "\x1b[2J";
export const CURSOR_HOME = "\x1b[H";

export type TerminalDataListener = (chunk: string) => void;

export interface TerminalOutput {
  write(chunk: string): unknown;
}

export interface TerminalInput {
  readonly isTTY?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(encoding: "utf8"): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

export interface TerminalSessionOptions {
  readonly stdout?: TerminalOutput | undefined;
  readonly stdin?: TerminalInput | undefined;
  readonly mouse?: boolean | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

interface TerminalSessionMode {
  readonly alternateScreen: boolean;
  readonly detachOnLeave: boolean;
}

function mouseRequested(options: TerminalSessionOptions): boolean {
  if (options.mouse !== undefined) return options.mouse;
  const env = options.env ?? process.env;
  if (env.CLAI_CLASSIC_MOUSE !== undefined) return env.CLAI_CLASSIC_MOUSE !== "0";
  const stdin = options.stdin ?? process.stdin;
  return stdin.isTTY === true && env.TERM !== "dumb";
}

export class TerminalSession {
  private readonly stdout: TerminalOutput;
  private readonly stdin: TerminalInput;
  private readonly mouse: boolean;
  private readonly mode: TerminalSessionMode;
  private enteredValue = false;
  private inputAttachedValue = false;
  private listener: ((chunk: string | Buffer) => void) | undefined;
  private handler: TerminalDataListener | undefined;

  constructor(
    options: TerminalSessionOptions = {},
    mode: TerminalSessionMode = { alternateScreen: true, detachOnLeave: true },
  ) {
    this.stdout = options.stdout ?? process.stdout;
    this.stdin = options.stdin ?? process.stdin;
    this.mouse = mouseRequested(options);
    this.mode = mode;
  }

  get entered(): boolean {
    return this.enteredValue;
  }

  get isOwned(): boolean {
    return this.enteredValue;
  }

  get inputAttached(): boolean {
    return this.inputAttachedValue;
  }

  get mouseEnabled(): boolean {
    return this.mouse;
  }

  enter(): void {
    if (this.enteredValue) return;
    this.enteredValue = true;
    if (this.mode.alternateScreen) {
      this.emit(ALT_SCREEN_ON);
      this.emit(CLEAR_SCREEN_ONLY);
      this.emit(CURSOR_HOME);
    }
    this.emit(BRACKETED_PASTE_ON);
    this.emit(CURSOR_HIDE);
    if (this.mouse) this.emit(MOUSE_ON);
  }

  leave(): void {
    if (!this.enteredValue) return;
    if (this.mode.detachOnLeave) this.detachInput();
    this.enteredValue = false;
    if (this.mouse) this.emit(MOUSE_OFF);
    this.emit(CURSOR_SHOW);
    this.emit(BRACKETED_PASTE_OFF);
    if (this.mode.alternateScreen) this.emit(ALT_SCREEN_OFF);
  }

  attachInput(onData?: TerminalDataListener): void {
    if (this.inputAttachedValue) return;
    this.handler = onData ?? this.handler ?? (() => {});
    this.inputAttachedValue = true;
    try {
      if (this.stdin.isTTY) this.stdin.setRawMode?.(true);
      this.stdin.setEncoding?.("utf8");
      this.stdin.resume?.();
    } catch {
      this.inputAttachedValue = false;
      return;
    }
    this.listener = (chunk) => {
      const handler = this.handler;
      if (!handler) return;
      handler(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    this.stdin.on("data", this.listener);
  }

  detachInput(): void {
    if (!this.inputAttachedValue) return;
    this.inputAttachedValue = false;
    if (this.listener) {
      this.stdin.off("data", this.listener);
      this.listener = undefined;
    }
    try {
      this.stdin.pause?.();
      if (this.stdin.isTTY) this.stdin.setRawMode?.(false);
    } catch {
      return;
    }
  }

  write(text: string): void {
    this.emit(text);
  }

  clearScreen(): void {
    this.emit(CLEAR_SCREEN);
  }

  private emit(sequence: string): void {
    try {
      this.stdout.write(sequence);
    } catch {
      return;
    }
  }
}

export function createTerminalSession(
  options: TerminalSessionOptions = {},
): TerminalSession {
  return new TerminalSession(options, {
    alternateScreen: true,
    detachOnLeave: true,
  });
}
