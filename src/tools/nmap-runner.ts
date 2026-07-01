import { platform } from "node:os";
import { commandAvailable } from "../os/pkgmgr.js";
import type { ToolResult } from "../types.js";
import { spawnArgv } from "./shell.js";
import { nmapScanNeedsPrivilege, toConnectScanArgv } from "./validate.js";
import type { ToolRunOptions } from "./tool-types.js";

/**
 * Pick the OS-appropriate privilege-escalation prefix for a raw-socket scan.
 *   - macOS / Linux  → `sudo` (clai forwards stdin so the user types their
 *     password live; the runner's interactive-stdin path handles the prompt).
 *   - Windows        → `sudo` on Win11 build 26052+ if present, else `gsudo`
 *     if installed; otherwise no prefix (the user must run from an elevated
 *     terminal — nmap SYN scans need Administrator + Npcap there).
 * Returns the elevation command + leading argv, or undefined when no helper
 * is available (caller then falls back to an unprivileged connect scan).
 */
async function elevationPrefix(): Promise<
  { command: string; argv: string[] } | undefined
> {
  if (process.getuid && process.getuid() === 0) {
    // Already root — no wrapper needed.
    return { command: "", argv: [] };
  }
  if (platform() === "win32") {
    if (await commandAvailable("sudo")) return { command: "sudo", argv: [] };
    if (await commandAvailable("gsudo")) return { command: "gsudo", argv: [] };
    return undefined;
  }
  if (await commandAvailable("sudo")) {
    // -p sets a clear prompt; clai's interactive-stdin lets the user type it.
    return { command: "sudo", argv: ["-p", "[clai] sudo password for nmap: "] };
  }
  if (await commandAvailable("doas")) return { command: "doas", argv: [] };
  return undefined;
}

/** Heuristic: did an nmap/sudo invocation fail because of missing privileges? */
function looksLikePrivilegeError(output: string): boolean {
  return /(?:requires root privileges|you (?:requested|need) (?:a scan type|root)|operation not permitted|must (?:be|run as) root|raw sockets?|sudo: (?:a (?:password|terminal) is required|no askpass|3 incorrect)|incorrect password|authentication failure|permission denied|requires (?:administrator|elevation))/i.test(
    output,
  );
}

/**
 * Run an nmap scan, transparently obtaining the privileges a stealth/raw
 * scan needs and falling back to an unprivileged TCP connect scan when those
 * privileges can't be obtained (no sudo, password declined, etc.).
 *
 * Strategy:
 *   1. If the scan needs raw sockets and we're not root, wrap it in the
 *      OS-appropriate elevation helper (sudo / doas / gsudo). stdin is
 *      inherited so the user can type their password live — exactly the
 *      pattern documented for shell.exec sudo.
 *   2. If elevation is unavailable, or the privileged attempt fails in a way
 *      that looks like a permission/privilege error, retry as `-sT` (TCP
 *      connect) which works for any user on every OS.
 * This is the "most general approach first, then fall back" behavior the
 * scans need so they never dead-end on "you must be root".
 */
export async function runNmapScan(
  argv: string[],
  options?: ToolRunOptions,
): Promise<ToolResult> {
  const needsPrivilege = nmapScanNeedsPrivilege(argv);
  const prefix = needsPrivilege ? await elevationPrefix() : undefined;

  const attempts: Array<{
    command: string;
    argv: string[];
    stdinText?: string | undefined;
    interactiveStdin?: boolean | "auto";
    note?: string;
  }> = [];

  if (needsPrivilege && prefix) {
    if (prefix.command === "sudo") {
      // Authenticate in a short, dedicated process. In the TUI, never inherit
      // stdin for the long nmap scan: pipe the already-entered password to
      // sudo so Ink keeps receiving Escape/Ctrl+C while nmap is running.
      options?.onOutput?.(
        options?.requestSecret
          ? "\nAdministrator access is required for a stealth scan. Complete the secure password prompt below.\n"
          : "\nAdministrator access is required for a stealth scan. Enter your sudo password below; Ctrl+C cancels.\n",
        "stdout",
      );
      let auth: ToolResult;
      let sudoPassword: string | undefined;
      if (options?.requestSecret) {
        const password = await options.requestSecret({
          title: "Administrator access",
          prompt: "Enter your macOS password for sudo. It is sent only to sudo and is never stored.",
        });
        if (password === undefined) {
          return { ok: false, output: "Administrator authentication cancelled.", exitCode: 130 };
        }
        sudoPassword = password;
        auth = await spawnArgv({
          command: "sudo",
          argv: ["-S", "-p", "", "-v"],
          stdinText: `${password}\n`,
          timeoutMs: 30_000,
          signal: options.signal,
          onOutput: options.onOutput,
          noArtifact: true,
          interactiveStdin: false,
        });
      } else {
        // Classic REPL: let sudo read directly from its controlling terminal.
        auth = await spawnArgv({
          command: "sudo",
          argv: [...prefix.argv, "-v"],
          timeoutMs: 120_000,
          signal: options?.signal,
          onOutput: options?.onOutput,
          interactiveStdin: true,
          noArtifact: true,
        });
      }
      if (options?.signal?.aborted || auth.exitCode === 130) return auth;
      if (auth.ok) {
        attempts.push({
          command: "sudo",
          argv: options?.requestSecret ? ["-S", "-p", "", "nmap", ...argv] : ["-n", "nmap", ...argv],
          stdinText: options?.requestSecret ? `${sudoPassword ?? ""}\n` : undefined,
          note: "Administrator access confirmed. Starting stealth scan (ESC cancels).",
        });
      } else {
        options?.onOutput?.(
          "\nSudo authentication was not completed; using an unprivileged TCP connect scan instead.\n",
          "stderr",
        );
      }
    } else if (prefix.command) {
      attempts.push({
        command: prefix.command,
        argv: [...prefix.argv, "nmap", ...argv],
        interactiveStdin: true,
        note: `Running a stealth scan with ${prefix.command} (you may be prompted for your password).`,
      });
    } else {
      // Already root.
      attempts.push({ command: "nmap", argv });
    }
    // Fallback: unprivileged connect scan if elevation fails/declines.
    attempts.push({
      command: "nmap",
      argv: toConnectScanArgv(argv),
      note: "Privileged scan unavailable — falling back to an unprivileged TCP connect scan (-sT).",
    });
  } else if (needsPrivilege && !prefix) {
    // No elevation helper at all — go straight to the connect-scan fallback,
    // but tell the user why the stealth scan was downgraded.
    attempts.push({
      command: "nmap",
      argv: toConnectScanArgv(argv),
      note:
        platform() === "win32"
          ? "No elevation helper found (sudo/gsudo). Run from an Administrator terminal with Npcap for a SYN scan; using a TCP connect scan (-sT) for now."
          : "No sudo/doas available for a raw-socket SYN scan — using an unprivileged TCP connect scan (-sT) instead.",
    });
  } else {
    attempts.push({ command: "nmap", argv });
  }

  let last: ToolResult | undefined;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i]!;
    if (options?.signal?.aborted) {
      return { ok: false, output: "Command aborted.", exitCode: 130 };
    }
    if (attempt.note) options?.onOutput?.(`\n${attempt.note}\n`, "stdout");
    const result = await spawnArgv({
      command: attempt.command,
      argv: attempt.argv,
      stdinText: attempt.stdinText,
      timeoutMs: 300_000,
      signal: options?.signal,
      onOutput: options?.onOutput,
      ...(attempt.interactiveStdin !== undefined
        ? { interactiveStdin: attempt.interactiveStdin }
        : {}),
    });
    last = result;
    // Success, or a non-privilege failure we shouldn't paper over → return.
    const isLastAttempt = i === attempts.length - 1;
    if (result.ok || isLastAttempt || !looksLikePrivilegeError(result.output)) {
      return result;
    }
    // Otherwise loop to the next (fallback) attempt.
  }
  return last ?? { ok: false, output: "nmap produced no result.", exitCode: 1 };
}
