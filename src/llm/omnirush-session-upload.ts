import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { ProviderId } from "../types.js";
import { getConfig } from "../store/config.js";
import { getDataDir } from "../store/paths.js";
import { getActiveSessionWorkspace } from "../store/session-workspace.js";

export interface OmnirushSessionState {
  readonly sessionId: string;
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
}

export interface OmnirushTurnResult {
  readonly status: string;
}

export interface OmnirushSessionSource {
  getState(): OmnirushSessionState;
  onTurnEnd(listener: (result: OmnirushTurnResult) => void): () => void;
  subscribe(listener: () => void): () => void;
}

export interface OmnirushUploadResult {
  readonly exitCode: number;
  readonly output?: string | undefined;
}

export type OmnirushUploadRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<OmnirushUploadResult>;

export interface OmnirushCliSessionUploaderOptions {
  readonly sessionId: string;
  readonly workspaceDir?: string | undefined;
  readonly command?: string | undefined;
  readonly runner?: OmnirushUploadRunner | undefined;
  readonly now?: (() => Date) | undefined;
  readonly report?: ((message: string) => void) | undefined;
  readonly enabled?: (() => boolean) | undefined;
}

export interface BindOmnirushSessionUploadOptions {
  readonly source: OmnirushSessionSource;
  readonly noHistory?: boolean | undefined;
  readonly command?: string | undefined;
  readonly runner?: OmnirushUploadRunner | undefined;
  readonly workspaceDir?: ((sessionId: string) => string) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly report?: ((message: string) => void) | undefined;
}

export interface OmnirushSessionUploadBinding {
  close(): Promise<void>;
  dispose(): void;
}

type UploadPhase = "turn_completed" | "session_end";

function sessionWorkspaceDir(sessionId: string): string {
  const active = getActiveSessionWorkspace();
  if (active) return join(active.rootDir, "omnirush-cli-session");
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return join(getDataDir(), "omnirush-cli-sessions", digest);
}

function uploadCommand(): string {
  return process.env.OMNIRUSH_CLI_PATH?.trim() || "omnirush";
}

async function defaultRunner(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
): Promise<OmnirushUploadResult> {
  const result = await execa(command, args, {
    all: true,
    cwd: options.cwd,
    reject: false,
    timeout: 120_000,
    windowsHide: true,
  });
  return {
    exitCode: result.exitCode ?? 1,
    ...(result.all ? { output: result.all } : {}),
  };
}

function disabledByEnvironment(): boolean {
  return /^(0|false|off|no)$/i.test(
    process.env.CLAI_OMNIRUSH_SESSION_UPLOAD?.trim() ?? "",
  );
}

function uploadAllowed(noHistory = false): boolean {
  return !noHistory && !getConfig().privateMode && !disabledByEnvironment();
}

export function isOmnirushSessionUploadEnabled(
  state: OmnirushSessionState,
  noHistory = false,
): boolean {
  return state.provider === "omnirush" && uploadAllowed(noHistory);
}

function sourceText(
  sessionId: string,
  sequence: number,
  phase: UploadPhase,
  status: string,
  capturedAt: Date,
): string {
  const state = JSON.stringify({
    session_id: sessionId,
    sequence,
    phase,
    status,
    captured_at: capturedAt.toISOString(),
  });
  return [
    `export const claiSession = ${state} as const;`,
    "",
    "export function advanceClaiSession(value: number): number {",
    `  return value + ${sequence};`,
    "}",
    "",
  ].join("\n");
}

async function writeWorkspace(
  workspaceDir: string,
  sessionId: string,
  sequence: number,
  phase: UploadPhase,
  status: string,
  capturedAt: Date,
): Promise<void> {
  const sourceDir = join(workspaceDir, "src");
  await mkdir(sourceDir, { recursive: true, mode: 0o700 });
  const manifest = JSON.stringify(
    {
      name: "clai-omnirush-session",
      version: "1.0.0",
      private: true,
      type: "module",
    },
    null,
    2,
  );
  await Promise.all([
    writeFile(join(workspaceDir, "package.json"), `${manifest}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(
      join(sourceDir, "clai-session.ts"),
      sourceText(sessionId, sequence, phase, status, capturedAt),
      { encoding: "utf8", mode: 0o600 },
    ),
  ]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uploadFailureMessage(result: OmnirushUploadResult): string {
  const output = result.output ?? "";
  if (/unauthorized|no access token|account[_\s-]*required|status[^0-9]{0,8}401/i.test(output)) {
    return "OmniRush session upload needs a fresh OmniRush CLI login; run `omnirush login`";
  }
  return `OmniRush session upload exited with code ${result.exitCode}`;
}

function commandMissing(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ENOENT";
}

export class OmnirushCliSessionUploader {
  private sequence = 0;
  private started = false;
  private closed = false;
  private unavailable = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly workspaceDir: string;
  private readonly command: string;
  private readonly runner: OmnirushUploadRunner;
  private readonly now: () => Date;
  private readonly report: (message: string) => void;
  private readonly enabled: () => boolean;

  constructor(private readonly options: OmnirushCliSessionUploaderOptions) {
    this.workspaceDir = options.workspaceDir ?? sessionWorkspaceDir(options.sessionId);
    this.command = options.command?.trim() || uploadCommand();
    this.runner = options.runner ?? defaultRunner;
    this.now = options.now ?? (() => new Date());
    this.report = options.report ?? (() => undefined);
    this.enabled = options.enabled ?? (() => true);
  }

  recordTurn(status: string): Promise<void> {
    if (this.closed || this.unavailable || !this.enabled()) return this.tail;
    this.started = true;
    return this.enqueue("turn_completed", status);
  }

  close(): Promise<void> {
    if (this.closed) return this.tail;
    this.closed = true;
    if (!this.started || this.unavailable || !this.enabled()) return this.tail;
    return this.enqueue("session_end", "closed");
  }

  private enqueue(phase: UploadPhase, status: string): Promise<void> {
    const sequence = ++this.sequence;
    const capturedAt = this.now();
    const run = async (): Promise<void> => {
      if (!this.enabled()) return;
      await writeWorkspace(
        this.workspaceDir,
        this.options.sessionId,
        sequence,
        phase,
        status,
        capturedAt,
      );
      if (this.unavailable) return;
      try {
        const result = await this.runner(
          this.command,
          ["upload", "--dir", this.workspaceDir, "--yes"],
          { cwd: this.workspaceDir },
        );
        if (result.exitCode !== 0) this.report(uploadFailureMessage(result));
      } catch (error) {
        if (commandMissing(error)) this.unavailable = true;
        this.report(
          commandMissing(error)
            ? "OmniRush session upload is unavailable because the OmniRush CLI was not found"
            : `OmniRush session upload failed: ${errorText(error)}`,
        );
      }
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function bindOmnirushSessionUpload(
  options: BindOmnirushSessionUploadOptions,
): OmnirushSessionUploadBinding {
  let active: OmnirushCliSessionUploader | undefined;
  let activeSessionId: string | undefined;
  let disposed = false;

  const closeActive = (): Promise<void> => {
    const uploader = active;
    active = undefined;
    activeSessionId = undefined;
    return uploader?.close() ?? Promise.resolve();
  };

  const reconcile = (): void => {
    const state = options.source.getState();
    if (
      active &&
      (activeSessionId !== state.sessionId ||
        !isOmnirushSessionUploadEnabled(state, options.noHistory))
    ) {
      void closeActive();
    }
  };

  const uploaderFor = (state: OmnirushSessionState): OmnirushCliSessionUploader | undefined => {
    if (!isOmnirushSessionUploadEnabled(state, options.noHistory)) return undefined;
    if (active && activeSessionId === state.sessionId) return active;
    const prior = active;
    active = new OmnirushCliSessionUploader({
      sessionId: state.sessionId,
      workspaceDir: options.workspaceDir?.(state.sessionId),
      command: options.command,
      runner: options.runner,
      now: options.now,
      report: options.report,
      enabled: () => uploadAllowed(options.noHistory),
    });
    activeSessionId = state.sessionId;
    if (prior) void prior.close();
    return active;
  };

  const disposeTurn = options.source.onTurnEnd((result) => {
    if (disposed) return;
    reconcile();
    const state = options.source.getState();
    void uploaderFor(state)?.recordTurn(result.status);
  });
  const disposeState = options.source.subscribe(() => {
    if (!disposed) reconcile();
  });

  return {
    async close() {
      if (disposed) return;
      disposed = true;
      disposeTurn();
      disposeState();
      await closeActive();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeTurn();
      disposeState();
      void closeActive();
    },
  };
}
