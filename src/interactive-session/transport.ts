
import type { TreeSignalOutcome } from "../os/process-tree.js";
import type { Unsubscribe } from "./runtime.js";
import type {
  ControlInput,
  OutputStream,
  ProcessOutcome,
  SessionTransportKind,
  SubmitBehavior,
  TerminalDimensions,
} from "./types.js";

export interface TransportOutput {
  readonly stream: OutputStream;
  readonly bytes: Uint8Array;
  readonly observedAt: number;
}

export type DeliveryResult =
  | { readonly status: "delivered"; readonly deliveredBytes: number }
  | { readonly status: "not-delivered"; readonly deliveredBytes: 0; readonly cause?: unknown }
  | { readonly status: "unknown"; readonly deliveredBytes: number; readonly cause?: unknown };

export interface SessionTransport {
  readonly kind: SessionTransportKind;
  readonly pid: number;
  readonly processGroupId?: number | undefined;
  readonly identity: string | undefined;
  write(bytes: Uint8Array): Promise<DeliveryResult>;
  control(action: ControlInput): Promise<DeliveryResult>;
  closeInput(): Promise<DeliveryResult>;
  resize?(dimensions: TerminalDimensions): Promise<void>;
  pauseOutput(): void;
  resumeOutput(): void;
  requestTreeTermination(kind: "graceful" | "forceful"): Promise<TreeSignalOutcome>;
  onOutput(listener: (event: TransportOutput) => void): Unsubscribe;
  onExit(listener: (outcome: ProcessOutcome) => void): Unsubscribe;
  waitForOutputDrain?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface LaunchIdentity {
  readonly pid: number;
  readonly processGroupId?: number | undefined;
  readonly identity: string | undefined;
}

export interface LaunchRequest {
  readonly command: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly onLaunchIdentity?: ((identity: LaunchIdentity) => void) | undefined;
}

export interface LaunchResult {
  readonly transport: SessionTransport;
}

export interface PtyCapability {
  readonly available: boolean;
  readonly platform: NodeJS.Platform;
  readonly reason?: string | undefined;
}

export interface SessionTransportFactory {
  capability(platform?: NodeJS.Platform): Promise<PtyCapability>;
  startPipe(request: LaunchRequest): Promise<LaunchResult>;
  startPty(
    request: LaunchRequest & { dimensions: TerminalDimensions },
  ): Promise<LaunchResult>;
}

export class LaunchFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly spawnConfirmed: boolean,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "LaunchFailure";
  }
}


export function enterSequence(kind: SessionTransportKind): Uint8Array {
  return Buffer.from(kind === "pty" ? "\r" : "\n", "utf8");
}

export function encodeTextInput(
  text: string,
  submit: SubmitBehavior,
  kind: SessionTransportKind,
): Uint8Array {
  const body = Buffer.from(text, "utf8");
  if (submit === "none") return body;
  return Buffer.concat([body, Buffer.from(enterSequence(kind))]);
}

const ARROWS: Record<"up" | "down" | "left" | "right", string> = {
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
};

export function ptyControlBytes(
  action: ControlInput,
  platform: NodeJS.Platform = process.platform,
): Uint8Array | undefined {
  switch (action) {
    case "interrupt":
      return Buffer.from([0x03]);
    case "eof":
      return platform === "win32"
        ? Buffer.from([0x1a, 0x0d])
        : Buffer.from([0x04]);
    case "suspend":
      return platform === "win32" ? undefined : Buffer.from([0x1a]);
    case "escape":
      return Buffer.from([0x1b]);
    case "tab":
      return Buffer.from([0x09]);
    case "backspace":
      return Buffer.from([0x7f]);
    case "up":
    case "down":
    case "left":
    case "right":
      return Buffer.from(ARROWS[action], "utf8");
    default:
      return undefined;
  }
}

export type PipeControlAction =
  | { readonly kind: "signal"; readonly signal: NodeJS.Signals }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "close-input" }
  | { readonly kind: "unsupported" };

export function pipeControlAction(
  action: ControlInput,
  platform: NodeJS.Platform = process.platform,
): PipeControlAction {
  if (action === "interrupt") {
    return platform === "win32"
      ? { kind: "signal", signal: "SIGTERM" }
      : { kind: "signal", signal: "SIGINT" };
  }
  if (action === "suspend") {
    return platform === "win32"
      ? { kind: "unsupported" }
      : { kind: "signal", signal: "SIGTSTP" };
  }
  if (action === "eof") return { kind: "close-input" };
  const bytes = ptyControlBytes(action, platform);
  return bytes ? { kind: "bytes", bytes } : { kind: "unsupported" };
}
