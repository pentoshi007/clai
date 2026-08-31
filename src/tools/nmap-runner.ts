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

async function elevationPrefix(): Promise<
  { command: string; argv: string[] } | undefined
> {
  if (process.getuid && process.getuid() === 0) {
    return { command: "", argv: [] };
  }
  if (platform() === "win32") {
    if (await commandAvailable("sudo")) return { command: "sudo", argv: [] };
    if (await commandAvailable("gsudo")) return { command: "gsudo", argv: [] };
    return undefined;
  }
  if (await commandAvailable("sudo")) {
    return { command: "sudo", argv: ["-p", "[clai] sudo password for nmap: "] };
  }
  if (await commandAvailable("doas")) return { command: "doas", argv: [] };
  return undefined;
}

function looksLikePrivilegeError(output: string): boolean {
  return /(?:requires root privileges|you (?:requested|need) (?:a scan type|root)|operation not permitted|must (?:be|run as) root|raw sockets?|sudo: (?:a (?:password|terminal) is required|no askpass|3 incorrect)|incorrect password|authentication failure|permission denied|requires (?:administrator|elevation))/i.test(
    output,
  );
}

function canInteractiveSudo(): boolean {
  return Boolean(process.stdin.isTTY);
}

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
            attempts.push({
              command: "sudo",
              argv: ["-S", "-p", "", "nmap", ...scanArgv],
              stdinText: formatSudoStdinPassword(auth.password),
              interactiveStdin: false,
              note: "Administrator access confirmed. Starting stealth scan (ESC cancels).",
            });
          }
        } else {
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
      attempts.push({ command: "nmap", argv: scanArgv, interactiveStdin: false });
    }
    const connectArgv = withNmapSkipDiscovery(toConnectScanArgv(scanArgv));
    attempts.push({
      command: "nmap",
      argv: connectArgv,
      note: "Privileged scan unavailable — falling back to an unprivileged TCP connect scan (-sT -Pn).",
    });
  } else if (needsPrivilege && !prefix) {
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
    if (
      !result.ok &&
      attempt.stdinText !== undefined &&
      looksLikeSudoAuthError(result.output)
    ) {
      evictSudoSession();
    }
    const isLastAttempt = i === attempts.length - 1;
    if (result.ok || isLastAttempt || !looksLikePrivilegeError(result.output)) {
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
  }
  return last ?? { ok: false, output: "nmap produced no result.", exitCode: 1 };
}
