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
  readonly active?: boolean | undefined;
  readonly attached: boolean;
  readonly independentViews?: boolean | undefined;
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
  readonly active?: boolean | undefined;
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
  readonly independentViews?: boolean | undefined;
}

export interface RuntimeTerminalOptions {
  readonly ui: "auto" | "classic" | "tui";
  readonly env: Readonly<Record<string, string>>;
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
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  readonly supportsRepaint?: boolean | undefined;
  readonly independentViews?: boolean | undefined;
  readonly terminal?: RuntimeTerminalOptions | undefined;
}

export interface RuntimeAckFrame {
  readonly version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly type: "ack";
  readonly sessionId: string;
  readonly sharedInput?: boolean | undefined;
  readonly independentViews?: boolean | undefined;
}

export interface RuntimeErrorFrame {
  readonly version: typeof RUNTIME_PROTOCOL_VERSION;
  readonly type: "error";
  readonly message: string;
}

export type RuntimeClientFrame =
  | { readonly type: "input"; readonly data: string }
  | {
      readonly type: "resize";
      readonly columns: number;
      readonly rows: number;
    }
  | { readonly type: "detach" }
  | { readonly type: "claim-input" }
  | { readonly type: "ping" };

export type RuntimeChildFrame =
  | {
      readonly type: "status";
      readonly sessionId: string;
      readonly cwd: string;
      readonly busy: boolean;
      readonly active?: boolean | undefined;
      readonly title?: string | undefined;
    }
  | { readonly type: "minimise"; readonly clientId?: string | undefined }
  | { readonly type: "view-output"; readonly clientId: string; readonly data: string }
  | { readonly type: "view-closed"; readonly clientId: string }
  | { readonly type: "exiting"; readonly exitCode: number }
  | {
      readonly type: "repaint-result";
      readonly requestId: string;
      readonly accepted: boolean;
    }
  | {
      readonly type: "switch";
      readonly sessionId: string;
      readonly closeCurrent: boolean;
      readonly fresh?: boolean | undefined;
      readonly clientId?: string | undefined;
    };

export type RuntimeViewFrame =
  | { readonly type: "view-attach"; readonly clientId: string; readonly columns: number; readonly rows: number; readonly terminal: RuntimeTerminalOptions }
  | { readonly type: "view-input"; readonly clientId: string; readonly data: string }
  | { readonly type: "view-resize"; readonly clientId: string; readonly columns: number; readonly rows: number }
  | { readonly type: "view-detach"; readonly clientId: string };

export type RuntimeHostFrame =
  | RuntimeViewFrame
  | { readonly type: "pong" }
  | { readonly type: "input-owner"; readonly active: boolean }
  | { readonly type: "shutdown" }
  | { readonly type: "repaint"; readonly requestId: string }
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
