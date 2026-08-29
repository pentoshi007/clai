export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export type RuntimePhase = "starting" | "running" | "stopping" | "failed";

export interface RuntimeMetadata {
  readonly version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly hostPid: number;
  readonly hostIdentity?: string | undefined;
  readonly childPid?: number | undefined;
  readonly childIdentity?: string | undefined;
  readonly socketPath: string;
  readonly token: string;
  readonly cwd: string;
  readonly title?: string | undefined;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly phase: RuntimePhase;
  readonly busy: boolean;
  readonly attached: boolean;
  readonly error?: string | undefined;
}

export interface RuntimeView {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title?: string | undefined;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly phase: RuntimePhase;
  readonly busy: boolean;
  readonly attached: boolean;
}

export interface RuntimeLaunchSpec {
  readonly file: string;
  readonly args: readonly string[];
}

export interface RuntimeHostPayload {
  readonly version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly cwd: string;
  readonly launch: RuntimeLaunchSpec;
  readonly columns: number;
  readonly rows: number;
  readonly idleTimeoutMs: number;
}

export type RuntimeChannelRole =
  | "probe"
  | "client-control"
  | "client-terminal"
  | "child";

export interface RuntimeAuthFrame {
  readonly version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly type: "auth";
  readonly role: RuntimeChannelRole;
  readonly token: string;
  readonly clientId?: string | undefined;
}

export interface RuntimeAckFrame {
  readonly version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly type: "ack";
  readonly sessionId: string;
}

export interface RuntimeErrorFrame {
  readonly version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly type: "error";
  readonly message: string;
}

export type RuntimeClientFrame =
  | {
      readonly type: "resize";
      readonly columns: number;
      readonly rows: number;
    }
  | { readonly type: "detach" }
  | { readonly type: "ping" };

export type RuntimeChildFrame =
  | {
      readonly type: "status";
      readonly sessionId: string;
      readonly cwd: string;
      readonly busy: boolean;
      readonly title?: string | undefined;
    }
  | { readonly type: "minimise" }
  | { readonly type: "exiting"; readonly exitCode: number }
  | {
      readonly type: "switch";
      readonly sessionId: string;
      readonly closeCurrent: boolean;
      readonly fresh?: boolean | undefined;
    };

export type RuntimeHostFrame =
  | { readonly type: "pong" }
  | { readonly type: "shutdown" }
  | {
      readonly type: "detached";
      readonly reason: "minimise" | "requested" | "taken-over" | "connection-lost";
      readonly sessionId: string;
    }
  | {
      readonly type: "switch";
      readonly sessionId: string;
      readonly fresh?: boolean | undefined;
    }
  | {
      readonly type: "exit";
      readonly exitCode: number;
      readonly signal?: string | undefined;
    };
