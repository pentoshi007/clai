import { platform } from "node:os";
import { commandAvailable } from "../os/pkgmgr.js";
import type { ToolResult } from "../types.js";
import {
  evictSudoSession,
  formatSudoStdinPassword,
  looksLikeSudoAuthError,
  obtainSudoPassword,
} from "./sudo-session.js";
import {
  getAllowInteractiveStdinInherit,
  spawnArgv,
} from "./shell.js";
import {
  isNmapSingleHostTarget,
  looksLikeNmapNoHostsUp,
  nmapArgvHasPn,
  nmapScanNeedsPrivilege,
  toConnectScanArgv,
  withNmapSkipDiscovery,
} from "./validate.js";
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

function canInteractiveSudo(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Run an nmap scan, transparently obtaining the privileges a stealth/raw
 * scan needs and falling back to an unprivileged TCP connect scan when those
 * privileges can't be obtained (no sudo, password declined, etc.).
 *
 * Strategy:
 *   1. Single-host port scans get -Pn so failed host-discovery pings do not
 *      report "0 hosts up" while ports are actually open.
 *   2. If the scan needs raw sockets and we're not root, wrap it in the
 *      OS-appropriate elevation helper (sudo / doas / gsudo). Prefer the
 *      secure requestSecret path (TUI); else interactive TTY sudo.
 *   3. If elevation is unavailable, or the privileged attempt fails in a way
 *      that looks like a permission/privilege error, retry as `-sT` (TCP
 *      connect) which works for any user on every OS.
 *   4. If a run still looks like "host down / 0 hosts up" without -Pn, retry
 *      once with -Pn before returning.
 */
export type NmapScanDepth = "standard" | "deep" | "full";

export interface NmapTimeoutPolicy {
  readonly depth: NmapScanDepth;
  readonly timeoutMs: number;
  readonly source: "profile" | "environment" | "call";
}

const NMAP_TIMEOUTS_MS: Readonly<Record<NmapScanDepth, number>> = {
  standard: 5 * 60_000,
  deep: 15 * 60_000,
  full: 45 * 60_000,
};

/** Resolve a resource-aware timeout from the effective Nmap argv.
 * CLAI_NMAP_TIMEOUT_MS is an operator override, primarily for CI and tightly
 * controlled environments; invalid/unsafe values are ignored.
 */
export function resolveNmapTimeoutPolicy(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): NmapTimeoutPolicy {
  const configured = Number(env.CLAI_NMAP_TIMEOUT_MS);
  if (Number.isSafeInteger(configured) && configured >= 30_000) {
    return { depth: inferNmapScanDepth(argv), timeoutMs: configured, source: "environment" };
  }

  const depth = inferNmapScanDepth(argv);
  return { depth, timeoutMs: NMAP_TIMEOUTS_MS[depth], source: "profile" };
}

function inferNmapScanDepth(argv: readonly string[]): NmapScanDepth {
  if (argv.includes("-p-")) return "full";
  const portsIndex = argv.findIndex((arg) => arg === "-p");
  const portSpec = portsIndex >= 0 ? argv[portsIndex + 1] ?? "" : "";
  if (/^(?:1-65535|1-65534|0-65535)$/.test(portSpec)) return "full";
  const explicitPorts = portSpec ? portSpec.split(",").length : 0;

  const topPortsIndex = argv.findIndex((arg) => arg === "--top-ports");
  const topPorts = topPortsIndex >= 0 ? Number(argv[topPortsIndex + 1]) : 0;
  const hasDeepEnumeration = argv.some((arg) =>
    arg === "-sV" || arg === "-sC" || arg === "-A" || arg.startsWith("--script"),
  );
  if (topPorts > 1_000 || explicitPorts > 1_000 || hasDeepEnumeration) return "deep";
  return "standard";
}

export async function runNmapScan(
  argv: string[],
  options?: ToolRunOptions,
  timeoutMsOverride?: number,
): Promise<ToolResult> {
  // Known single hosts: skip discovery by default (ICMP/ARP often blocked or
  // needs root; false "0 hosts up" is a common agent failure mode).
  let scanArgv =
    isNmapSingleHostTarget(argv) && !nmapArgvHasPn(argv)
      ? withNmapSkipDiscovery(argv)
      : [...argv];

  const needsPrivilege = nmapScanNeedsPrivilege(scanArgv);
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
      // Never inherit stdin in OpenTUI (allowInteractiveStdinInherit=false):
      // that freezes the UI with a raw "Password:" prompt. Prefer secret modal
      // + sudo -S; classic REPL may still use TTY only when inherit is allowed.
      const useSecret = Boolean(options?.requestSecret);
      const useTty =
        !useSecret &&
        canInteractiveSudo() &&
        getAllowInteractiveStdinInherit();

      if (!useSecret && !useTty) {
        options?.onOutput?.(
          "\nCannot prompt for sudo password in this UI without freezing it. Using an unprivileged TCP connect scan (-sT -Pn).\n",
          "stderr",
        );
      } else {
        options?.onOutput?.(
          useSecret
            ? "\nAdministrator access is required for a stealth scan. Complete the secure password prompt below.\n"
            : "\nAdministrator access is required for a stealth scan. Enter your sudo password below; Ctrl+C cancels.\n",
          "stdout",
        );
        if (useSecret && options?.requestSecret) {
          // Shared sudo session: parallel scans coalesce onto one password
          // prompt, and a validated password is reused for a few minutes so
          // every scan in the batch (not just the first) runs privileged.
          const auth = await obtainSudoPassword({
            requestSecret: options.requestSecret,
            title: "Administrator access",
            prompt:
              "Enter your password for sudo (nmap raw-socket scan). It is sent only to sudo, kept in memory for a few minutes so parallel privileged scans don't ask again, and never written to disk. Esc cancels.",
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.onOutput ? { onOutput: options.onOutput } : {}),
          });
          if (auth.status === "cancelled") {
            options?.onOutput?.(
              "\nSudo cancelled — falling back to unprivileged TCP connect scan (-sT -Pn).\n",
              "stderr",
            );
          } else if (auth.status === "failed") {
            const detail = auth.detail ? `\n${auth.detail}` : "";
            options?.onOutput?.(
              `\nSudo authentication failed; using an unprivileged TCP connect scan instead.${detail}\n`,
              "stderr",
            );
          } else {
            // Pipe the password into the real scan. Do NOT use `sudo -n`
            // after -v: OpenTUI spawns detached non-TTY children, so the
            // macOS sudo timestamp ticket does not stick and you get
            // "access confirmed" then "sudo: a password is required".
            attempts.push({
              command: "sudo",
              argv: ["-S", "-p", "", "nmap", ...scanArgv],
              stdinText: formatSudoStdinPassword(auth.password),
              interactiveStdin: false,
              note: "Administrator access confirmed. Starting stealth scan (ESC cancels).",
            });
          }
        } else {
          // Classic line REPL only (inherit allowed). TTY -v creates a
          // ticket that -n can use because both share the same terminal.
          const auth = await spawnArgv({
            command: "sudo",
            argv: [...prefix.argv, "-v"],
            timeoutMs: 120_000,
            signal: options?.signal,
            onOutput: options?.onOutput,
            interactiveStdin: true,
            noArtifact: true,
          });
          if (options?.signal?.aborted) return auth;
          if (auth.exitCode === 130) {
            options?.onOutput?.(
              "\nSudo authentication was cancelled; using an unprivileged TCP connect scan instead. Authentication will not be reopened automatically.\n",
              "stderr",
            );
          } else if (auth.ok) {
            attempts.push({
              command: "sudo",
              argv: ["-n", "nmap", ...scanArgv],
              interactiveStdin: false,
              note: "Administrator access confirmed. Starting stealth scan (ESC cancels).",
            });
          } else {
            const detail = auth.output?.trim()
              ? `\n${auth.output.trim().slice(0, 400)}`
              : "";
            options?.onOutput?.(
              `\nSudo authentication failed or was not completed; using an unprivileged TCP connect scan instead.${detail}\n`,
              "stderr",
            );
          }
        }
      }
    } else if (prefix.command) {
      // doas/gsudo: never inherit in TUI — fall through to connect scan.
      if (getAllowInteractiveStdinInherit()) {
        attempts.push({
          command: prefix.command,
          argv: [...prefix.argv, "nmap", ...scanArgv],
          interactiveStdin: true,
          note: `Running a stealth scan with ${prefix.command} (you may be prompted for your password).`,
        });
      } else {
        options?.onOutput?.(
          `\n${prefix.command} would need a TTY password prompt (blocked in this UI). Using unprivileged TCP connect scan (-sT -Pn).\n`,
          "stderr",
        );
      }
    } else {
      // Already root.
      attempts.push({ command: "nmap", argv: scanArgv, interactiveStdin: false });
    }
    // Fallback: unprivileged connect scan if elevation fails/declines.
    const connectArgv = withNmapSkipDiscovery(toConnectScanArgv(scanArgv));
    attempts.push({
      command: "nmap",
      argv: connectArgv,
      note: "Privileged scan unavailable — falling back to an unprivileged TCP connect scan (-sT -Pn).",
    });
  } else if (needsPrivilege && !prefix) {
    // No elevation helper at all — go straight to the connect-scan fallback,
    // but tell the user why the stealth scan was downgraded.
    attempts.push({
      command: "nmap",
      argv: withNmapSkipDiscovery(toConnectScanArgv(scanArgv)),
      note:
        platform() === "win32"
          ? "No elevation helper found (sudo/gsudo). Run from an Administrator terminal with Npcap for a SYN scan; using a TCP connect scan (-sT -Pn) for now."
          : "No sudo/doas available for a raw-socket SYN scan — using an unprivileged TCP connect scan (-sT -Pn) instead.",
    });
  } else {
    attempts.push({ command: "nmap", argv: scanArgv });
  }

  const configuredPolicy = resolveNmapTimeoutPolicy(scanArgv);
  const timeoutPolicy =
    typeof timeoutMsOverride === "number" && Number.isFinite(timeoutMsOverride)
      ? {
          ...configuredPolicy,
          timeoutMs: Math.max(1_000, Math.min(30 * 60_000, Math.floor(timeoutMsOverride))),
          source: "call" as const,
        }
      : configuredPolicy;
  options?.onOutput?.(
    `[nmap] ${timeoutPolicy.depth} scan timeout: ${Math.round(timeoutPolicy.timeoutMs / 60_000)}m (${timeoutPolicy.source})\n`,
    "stdout",
  );

  let last: ToolResult | undefined;
  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i]!;
    if (options?.signal?.aborted) {
      return { ok: false, output: "Command aborted.", exitCode: 130 };
    }
    if (attempt.note) options?.onOutput?.(`\n${attempt.note}\n`, "stdout");
    let result = await spawnArgv({
      command: attempt.command,
      argv: attempt.argv,
      stdinText: attempt.stdinText,
      timeoutMs: timeoutPolicy.timeoutMs,
      signal: options?.signal,
      onOutput: options?.onOutput,
      ...(attempt.interactiveStdin !== undefined
        ? { interactiveStdin: attempt.interactiveStdin }
        : {}),
    });

    // Host discovery false negative: retry once with -Pn on the same elevation.
    if (
      result.ok &&
      looksLikeNmapNoHostsUp(result.output) &&
      !nmapArgvHasPn(attempt.argv) &&
      isNmapSingleHostTarget(attempt.argv)
    ) {
      options?.onOutput?.(
        "\nHost discovery reported no hosts up — retrying once with -Pn (treat host as online).\n",
        "stdout",
      );
      result = await spawnArgv({
        command: attempt.command,
        argv: withNmapSkipDiscovery(attempt.argv),
        stdinText: attempt.stdinText,
        timeoutMs: timeoutPolicy.timeoutMs,
        signal: options?.signal,
        onOutput: options?.onOutput,
        ...(attempt.interactiveStdin !== undefined
          ? { interactiveStdin: attempt.interactiveStdin }
          : {}),
      });
    }

    last = result;
    // A privileged attempt that sudo itself rejected means the cached
    // password went stale (changed mid-session) — drop it so the next scan
    // prompts again instead of replaying a dead secret.
    if (
      !result.ok &&
      attempt.stdinText !== undefined &&
      looksLikeSudoAuthError(result.output)
    ) {
      evictSudoSession();
    }
    // Success, or a non-privilege failure we shouldn't paper over → return.
    const isLastAttempt = i === attempts.length - 1;
    if (result.ok || isLastAttempt || !looksLikePrivilegeError(result.output)) {
      // Annotate empty single-host results so the model does not loop forever.
      if (
        result.ok &&
        looksLikeNmapNoHostsUp(result.output) &&
        isNmapSingleHostTarget(attempt.argv)
      ) {
        return {
          ...result,
          output:
            result.output +
            "\n\nNote: nmap still reported no live host/open ports after -Pn. " +
            "The target may be offline, firewalled, or blocking this host. " +
            "Do not retry the same net.scan args in a loop — try different ports, " +
            "confirm the IP with net.context / net.pingSweep, or use shell.exec for a custom nmap line.",
        };
      }
      return result;
    }
    // Otherwise loop to the next (fallback) attempt.
  }
  return last ?? { ok: false, output: "nmap produced no result.", exitCode: 1 };
}
