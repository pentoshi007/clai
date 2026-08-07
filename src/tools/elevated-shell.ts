import { commandAvailable } from "../os/pkgmgr.js";
import type { ToolResult } from "../types.js";
import type { BackgroundSpawnSpec } from "./jobs.js";
import type { ToolRunOptions } from "./tool-types.js";
import { interactiveStdinKind, spawnArgv } from "./shell.js";

export function formatSudoStdinPassword(password: string): string {
  return `${password.replace(/[\r\n]+$/g, "")}\n`;
}

export type PreparedElevation =
  | { prepared: true; spec: BackgroundSpawnSpec }
  | { prepared: false; result: ToolResult };

const TTY_ONLY_MESSAGE =
  "This command needs a real terminal for its password/passphrase prompt (ssh, scp, rsync, gpg, passwd). " +
  "Start an interactive session with terminal.start and answer the prompt via terminal.send kind:\"secret\", " +
  "or rephrase it as a sudo command so clai can use the secure password modal.";

const WINDOWS_ELEVATION_MESSAGE =
  "This command needs elevation, which clai cannot automate on Windows without a terminal. " +
  "Run it in an interactive session with terminal.start, or from an elevated terminal.";

function truncateForPrompt(command: string, max = 160): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export async function preparePrivilegedBackgroundArgv(
  command: string,
  argv: string[],
  options: {
    signal?: AbortSignal | undefined;
    onOutput?: ToolRunOptions["onOutput"];
    requestSecret?: ToolRunOptions["requestSecret"];
    title?: string | undefined;
    prompt?: string | undefined;
  },
  dependencies: {
    available?: ((command: string) => Promise<boolean>) | undefined;
    runAuth?: (typeof spawnArgv) | undefined;
    isRoot?: (() => boolean) | undefined;
  } = {},
): Promise<PreparedElevation> {
  const isRoot = dependencies.isRoot ?? (() => process.getuid?.() === 0);
  if (isRoot()) {
    return { prepared: true, spec: { command, argv: [...argv] } };
  }
  const available = dependencies.available ?? commandAvailable;
  if (!(await available("sudo"))) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 1,
        output: "This background command requires administrator access, but sudo is unavailable.",
      },
    };
  }
  if (!options.requestSecret) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 1,
        output:
          "This background command requires administrator access, but no secure password prompt is available. " +
          "Run it from the interactive TUI or choose an explicitly unprivileged operation.",
      },
    };
  }

  const password = await options.requestSecret({
    title: options.title ?? "Administrator access",
    prompt:
      options.prompt ??
      "Enter your password for sudo. It is sent only to sudo stdin and is never stored. Esc cancels.",
  });
  if (password === undefined) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 130,
        output: "Administrator authentication cancelled; no background job was started.",
      },
    };
  }

  const stdinText = formatSudoStdinPassword(password);
  const runAuth = dependencies.runAuth ?? spawnArgv;
  let auth: ToolResult;
  try {
    auth = await runAuth({
      command: "sudo",
      argv: ["-S", "-p", "", "-v"],
      stdinText,
      timeoutMs: 30_000,
      signal: options.signal,
      onOutput: options.onOutput,
      noArtifact: true,
      interactiveStdin: false,
    });
  } catch (error) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 1,
        output: `sudo authentication could not start: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (options.signal?.aborted || auth.exitCode === 130) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: 130,
        output: auth.output || "Administrator authentication aborted; no background job was started.",
      },
    };
  }
  if (!auth.ok) {
    return {
      prepared: false,
      result: {
        ok: false,
        exitCode: auth.exitCode ?? 1,
        output: `sudo authentication failed; no background job was started.\n${(auth.output ?? "").trim().slice(0, 400)}`.trim(),
      },
    };
  }

  return {
    prepared: true,
    spec: {
      command: "sudo",
      argv: ["-S", "-p", "", command, ...argv],
      stdinText,
      display: ["sudo", command, ...argv].join(" "),
    },
  };
}

export async function prepareElevatedBackgroundCommand(
  shellCommand: string,
  options: Parameters<typeof preparePrivilegedBackgroundArgv>[2],
  dependencies?: Parameters<typeof preparePrivilegedBackgroundArgv>[3],
): Promise<PreparedElevation | undefined> {
  const kind = interactiveStdinKind(shellCommand);
  if (!kind) return undefined;
  if (kind === "tty") {
    return {
      prepared: false,
      result: { ok: false, exitCode: 1, output: TTY_ONLY_MESSAGE },
    };
  }
  if (process.platform === "win32") {
    return {
      prepared: false,
      result: { ok: false, exitCode: 1, output: WINDOWS_ELEVATION_MESSAGE },
    };
  }
  return preparePrivilegedBackgroundArgv(
    "sh",
    ["-c", shellCommand],
    {
      ...options,
      prompt:
        options.prompt ??
        `Enter your password for sudo. Command: ${truncateForPrompt(shellCommand)}. It is sent only to sudo stdin and is never stored. Esc cancels.`,
    },
    dependencies,
  );
}

export async function tryRunElevatedWithoutTty(
  command: string,
  options: {
    cwd?: string | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    onOutput?: ToolRunOptions["onOutput"];
    requestSecret?: ToolRunOptions["requestSecret"];
  },
  dependencies: {
    available?: ((command: string) => Promise<boolean>) | undefined;
    run?: (typeof spawnArgv) | undefined;
    isRoot?: (() => boolean) | undefined;
  } = {},
): Promise<ToolResult | undefined> {
  if (!options.requestSecret) return undefined;
  const kind = interactiveStdinKind(command);
  if (!kind) return undefined;
  if (kind === "tty") {
    return { ok: false, exitCode: 1, output: TTY_ONLY_MESSAGE };
  }
  if (process.platform === "win32") {
    return { ok: false, exitCode: 1, output: WINDOWS_ELEVATION_MESSAGE };
  }

  const isRoot = dependencies.isRoot ?? (() => process.getuid?.() === 0);
  if (isRoot()) return undefined;

  const available = dependencies.available ?? commandAvailable;
  if (!(await available("sudo"))) {
    return {
      ok: false,
      exitCode: 1,
      output:
        "This command needs administrator access, but sudo is unavailable. " +
        "Run it without elevation or in an interactive session via terminal.start.",
    };
  }

  const password = await options.requestSecret({
    title: "Administrator access",
    prompt: `Enter your password for sudo. Command: ${truncateForPrompt(command)}. It is sent only to sudo and is never stored. Esc cancels.`,
  });
  if (password === undefined) {
    return {
      ok: false,
      exitCode: 130,
      output:
        "Administrator authentication cancelled. Re-run and enter your password, or run without sudo.",
    };
  }

  const stdinPassword = formatSudoStdinPassword(password);
  const run = dependencies.run ?? spawnArgv;

  const auth = await run({
    command: "sudo",
    argv: ["-S", "-p", "", "-v"],
    stdinText: stdinPassword,
    timeoutMs: 30_000,
    signal: options.signal,
    onOutput: options.onOutput,
    noArtifact: true,
    interactiveStdin: false,
  });
  if (options.signal?.aborted || auth.exitCode === 130) {
    return auth.ok
      ? auth
      : {
          ok: false,
          exitCode: 130,
          output: auth.output || "Administrator authentication aborted.",
        };
  }
  if (!auth.ok) {
    return {
      ok: false,
      exitCode: auth.exitCode ?? 1,
      output:
        `sudo authentication failed.\n${(auth.output ?? "").trim().slice(0, 400)}`.trim(),
    };
  }

  return run({
    command: "sudo",
    argv: ["-S", "-p", "", "sh", "-c", command],
    stdinText: stdinPassword,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onOutput: options.onOutput,
    interactiveStdin: false,
  });
}
