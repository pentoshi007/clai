import { detectSystem } from "../os/detect.js";
import {
  detectPackageManager,
  assertSafePackageName,
  commandAvailable,
} from "../os/pkgmgr.js";
import { safeCwd } from "../os/cwd.js";
import type { ToolCall, ToolResult } from "../types.js";
import {
  fsEdit,
  fsDelete,
  fsList,
  fsRead,
  fsSearch,
  fsWrite,
  fsWriteMany,
  type FileWrite,
} from "./fs.js";
import { httpFetch } from "./http.js";
import { shellExec, spawnArgv } from "./shell.js";
import { imageOcr } from "./image.js";
import { pdfRead } from "./pdf.js";
import { webFetch } from "./web/fetch.js";
import { webSearch } from "./web/search.js";
import { RESPONSE_MODES, type ResponseMode } from "./web/types.js";
import { classifyToolCall } from "../safety/classifier.js";
import { loadScope } from "../store/scope.js";
import {
  parseHost,
  parsePortSpec,
  parseLegacyFlags,
  profileToNmapArgs,
  nmapScanNeedsPrivilege,
  toConnectScanArgv,
  type ScanProfile,
} from "./validate.js";
import { platform } from "node:os";
import { getNetworkContext } from "./network-context.js";
import { pingSweep } from "./net-ping-sweep.js";
import { toolCheckHandler } from "./capabilities.js";
import { jobManager } from "./jobs.js";
import { looksLongRunning } from "./command-intent.js";

export interface ToolRunOptions {
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  options?: ToolRunOptions,
) => Promise<ToolResult>;

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tool argument "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalResponseMode(
  args: Record<string, unknown>,
  key: string,
): ResponseMode | undefined {
  const value = args[key];
  if (
    typeof value === "string" &&
    (RESPONSE_MODES as readonly string[]).includes(value)
  ) {
    return value as ResponseMode;
  }
  return undefined;
}

/**
 * Map a package name to the executable it installs, when they differ. Used
 * by pkg.install to check whether the tool already exists before installing.
 * Most packages share their binary name, so this only lists the exceptions.
 */
const PACKAGE_BINARY_ALIASES: Record<string, string> = {
  ripgrep: "rg",
  dnsutils: "dig",
  "bind-utils": "dig",
  "bind9-dnsutils": "dig",
  "python3-pip": "pip3",
  "build-essential": "gcc",
  nodejs: "node",
  golang: "go",
  "g++": "g++",
  imagemagick: "magick",
  "netcat-openbsd": "nc",
  "net-tools": "ifconfig",
  coreutils: "ls",
};

function packageBinaryName(pkg: string): string {
  const lower = pkg.toLowerCase();
  if (PACKAGE_BINARY_ALIASES[lower]) return PACKAGE_BINARY_ALIASES[lower]!;
  // Strip a tap/cask prefix (homebrew "owner/tap/name" → "name") and any
  // version suffix (apt "pkg=1.2" → "pkg") so the binary guess is sane.
  const noTap = pkg.includes("/") ? pkg.slice(pkg.lastIndexOf("/") + 1) : pkg;
  return noTap.split(/[=@:]/)[0] ?? noTap;
}

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
async function runNmapScan(
  argv: string[],
  options?: ToolRunOptions,
): Promise<ToolResult> {
  const needsPrivilege = nmapScanNeedsPrivilege(argv);
  const prefix = needsPrivilege ? await elevationPrefix() : undefined;

  const attempts: Array<{
    command: string;
    argv: string[];
    interactiveStdin?: boolean | "auto";
    note?: string;
  }> = [];

  if (needsPrivilege && prefix) {
    if (prefix.command === "sudo") {
      // Authenticate in a short, dedicated interactive process. Keeping
      // stdin inherited for the entire nmap scan prevents Ink from receiving
      // Escape/Ctrl+C for minutes. Once `sudo -v` succeeds, the real scan can
      // use cached credentials with `-n` and release stdin back to the TUI.
      options?.onOutput?.(
        "\nAdministrator access is required for a stealth scan. Enter your sudo password below; Ctrl+C cancels.\n",
        "stdout",
      );
      const auth = await spawnArgv({
        command: "sudo",
        argv: [...prefix.argv, "-v"],
        timeoutMs: 120_000,
        signal: options?.signal,
        onOutput: options?.onOutput,
        interactiveStdin: true,
        noArtifact: true,
      });
      if (options?.signal?.aborted || auth.exitCode === 130) return auth;
      if (auth.ok) {
        attempts.push({
          command: "sudo",
          argv: ["-n", "nmap", ...argv],
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

/** Heuristic: did an nmap/sudo invocation fail because of missing privileges? */
function looksLikePrivilegeError(output: string): boolean {
  return /(?:requires root privileges|you (?:requested|need) (?:a scan type|root)|operation not permitted|must (?:be|run as) root|raw sockets?|sudo: (?:a (?:password|terminal) is required|no askpass|3 incorrect)|incorrect password|authentication failure|permission denied|requires (?:administrator|elevation))/i.test(
    output,
  );
}

export const toolRegistry: Record<string, ToolHandler> = {
  async "shell.exec"(args, options) {
    const command = requireString(args, "command");
    // Cross-OS non-blocking safety net: servers, watchers, and listeners
    // (npm run dev, vite, python -m http.server, nc -l, docker compose up,
    // tail -f, …) would otherwise block the agent's main thread until the
    // command's timeout — exactly the "I have to Ctrl+C" problem. Route them
    // to the background job manager (a detached child process on
    // macOS/Linux, a normal child on Windows) so the agent gets a job id
    // back immediately and can inspect output with shell.tail / shell.jobs.
    // The model is still encouraged to use shell.start directly; this just
    // catches the common mistake of using shell.exec for a server.
    if (looksLongRunning(command)) {
      const job = await jobManager.startJob(command, {
        cwd: optionalString(args, "cwd"),
      });
      if (job.ok) {
        return {
          ...job,
          output:
            `${job.output}\n\n` +
            "This command keeps running, so it was started in the BACKGROUND (a separate process) " +
            "instead of blocking. It is NOT finished — use shell.tail {\"id\":\"<id>\"} to read its " +
            "output, shell.jobs to list jobs, and shell.stop {\"id\":\"<id>\"} to stop it. " +
            "Do NOT wait on it or claim it exited.",
        };
      }
      return job;
    }
    return shellExec({
      command,
      cwd: optionalString(args, "cwd"),
      timeoutMs: optionalNumber(args, "timeoutMs"),
      signal: options?.signal,
      onOutput: options?.onOutput,
    });
  },
  async "fs.read"(args) {
    return fsRead(requireString(args, "path"), {
      maxBytes: optionalNumber(args, "maxBytes"),
    });
  },
  async "fs.write"(args) {
    return fsWrite(requireString(args, "path"), requireString(args, "content"));
  },
  async "fs.writeMany"(args) {
    const raw = args.files;
    if (!Array.isArray(raw)) {
      throw new Error(
        'fs.writeMany requires a "files" array of { path, content } objects',
      );
    }
    const files = raw as FileWrite[];
    return fsWriteMany(files);
  },
  async "fs.list"(args) {
    return fsList(optionalString(args, "path") ?? safeCwd(), {
      maxEntries: optionalNumber(args, "maxEntries"),
    });
  },
  async "fs.search"(args) {
    return fsSearch(
      requireString(args, "pattern"),
      optionalString(args, "path"),
    );
  },
  async "pkg.install"(args, options) {
    const tool = assertSafePackageName(requireString(args, "tool"));
    // Skip the install entirely if the tool is already on PATH. The executable
    // a package provides isn't always its package name (ripgrep→rg,
    // dnsutils→dig), so check the known binary alias too. This makes the
    // model's "check-then-install" intent cheap and idempotent.
    const checkArg = optionalString(args, "checkBinary");
    const binary = checkArg ?? packageBinaryName(tool);
    if (await commandAvailable(binary)) {
      return {
        ok: true,
        output: `${binary} is already installed and on PATH — skipping install.`,
        exitCode: 0,
      };
    }
    const pkgmgr = await detectPackageManager();
    const spec = pkgmgr.installArgv(tool);
    if (!spec) {
      // Unknown manager: fall back to an instructional message instead of
      // executing a malformed shell string.
      return { ok: false, output: pkgmgr.installCommand(tool), exitCode: 1 };
    }
    return spawnArgv({
      command: spec.command,
      argv: spec.argv,
      timeoutMs: 600_000,
      signal: options?.signal,
      onOutput: options?.onOutput,
    });
  },
  async "net.scan"(args, options) {
    const host = parseHost(requireString(args, "target"));
    const portsRaw = optionalString(args, "ports");
    const ports = portsRaw ? parsePortSpec(portsRaw) : undefined;
    const profile =
      args.profile &&
      typeof args.profile === "object" &&
      !Array.isArray(args.profile)
        ? (args.profile as ScanProfile)
        : undefined;
    const legacyFlags = optionalString(args, "flags");
    // ports and topPorts conflict on the nmap CLI — ports takes priority
    const cleanedProfile =
      ports && profile?.topPorts
        ? { ...profile, topPorts: undefined }
        : profile;
    const profileArgs = profileToNmapArgs(cleanedProfile);
    const legacyArgs = legacyFlags ? parseLegacyFlags(legacyFlags) : [];
    const argv: string[] = [];
    if (ports) argv.push("-p", ports);
    argv.push(...profileArgs, ...legacyArgs, host.value);
    return runNmapScan(argv, options);
  },
  async "http.fetch"(args) {
    const headers =
      args.headers &&
      typeof args.headers === "object" &&
      !Array.isArray(args.headers)
        ? (args.headers as Record<string, string>)
        : undefined;
    return httpFetch(requireString(args, "url"), {
      method: optionalString(args, "method"),
      body: optionalString(args, "body"),
      headers,
      maxBytes: optionalNumber(args, "maxBytes"),
      iOwnThis: args.iOwnThis === true || args.own === true,
    });
  },
  async "web.search"(args, options) {
    const query = requireString(args, "query");
    const maxResults = optionalNumber(args, "maxResults");
    const result = await webSearch(
      {
        query,
        ...(maxResults !== undefined ? { maxResults } : {}),
      },
      { ...(options?.signal ? { signal: options.signal } : {}) },
    );

    // "Search and read" — like a human (or Claude) following the most
    // relevant links. When fetchTop is set, fetch the readable content of the
    // top N result pages and append it so the agent gets real page text in a
    // SINGLE call instead of only snippets. Capped to 3 pages to stay fast and
    // keep context lean.
    const fetchTop = optionalNumber(args, "fetchTop");
    const want = fetchTop ? Math.max(0, Math.min(3, Math.floor(fetchTop))) : 0;
    if (!result.ok || want === 0) return result;

    const urls = extractResultUrls(result.output).slice(0, want);
    if (urls.length === 0) return result;

    const pages = await Promise.all(
      urls.map(async (url) => {
        try {
          const page = await webFetch(
            { url, responseMode: "readable", includeHeaders: false },
            { ...(options?.signal ? { signal: options.signal } : {}) },
          );
          const text = page.output.trim();
          // Keep each appended page modest so several fit within the model's
          // tool-output budget. For the full text of one page, the model can
          // call web.fetch on that single URL (it then gets the larger cap).
          const capped =
            text.length > 3500
              ? `${text.slice(0, 3500)}\n…[truncated — call web.fetch on this url for the full page]`
              : text;
          return `── PAGE: ${url} ${page.ok ? "" : "(fetch failed)"}\n${capped}`;
        } catch (error) {
          return `── PAGE: ${url} (fetch error: ${error instanceof Error ? error.message : String(error)})`;
        }
      }),
    );

    return {
      ...result,
      output: `${result.output}\n\n${pages.join("\n\n")}`,
    };
  },
  async "web.fetch"(args, options) {
    const url = requireString(args, "url");
    const fetchArgs: Parameters<typeof webFetch>[0] = { url };
    const maxBytes = optionalNumber(args, "maxBytes");
    if (maxBytes !== undefined) fetchArgs.maxBytes = maxBytes;
    const includeHeaders = optionalBoolean(args, "includeHeaders");
    if (includeHeaders !== undefined) fetchArgs.includeHeaders = includeHeaders;
    const includeTls = optionalBoolean(args, "includeTls");
    if (includeTls !== undefined) fetchArgs.includeTls = includeTls;
    const includeTiming = optionalBoolean(args, "includeTiming");
    if (includeTiming !== undefined) fetchArgs.includeTiming = includeTiming;
    const includeRedirectChain = optionalBoolean(args, "includeRedirectChain");
    if (includeRedirectChain !== undefined)
      fetchArgs.includeRedirectChain = includeRedirectChain;
    const responseMode = optionalResponseMode(args, "responseMode");
    if (responseMode !== undefined) fetchArgs.responseMode = responseMode;
    const redactSensitive = optionalBoolean(args, "redactSensitive");
    if (redactSensitive !== undefined)
      fetchArgs.redactSensitive = redactSensitive;
    return webFetch(fetchArgs, {
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  },
  async sysinfo() {
    return { ok: true, output: JSON.stringify(detectSystem(), null, 2) };
  },
  /**
   * Run a single DNS query without spinning up a full recon. Use for
   * narrow asks ("what's the A record for X", "find the MX for Y") so
   * the agent doesn't reach for nmap/whois when one dig is enough.
   */
  async "dns.lookup"(args, options) {
    const host = parseHost(requireString(args, "target"));
    const recordRaw = (optionalString(args, "record") ?? "A").toUpperCase();
    const allowed = new Set([
      "A",
      "AAAA",
      "ANY",
      "CAA",
      "CNAME",
      "MX",
      "NS",
      "PTR",
      "SOA",
      "SRV",
      "TXT",
    ]);
    if (!allowed.has(recordRaw)) {
      throw new Error(
        `dns.lookup: unsupported record type "${recordRaw}". Allowed: ${[...allowed].join(", ")}`,
      );
    }
    return spawnArgv({
      command: "dig",
      argv: [host.value, recordRaw, "+noall", "+answer", "+stats"],
      timeoutMs: 30_000,
      signal: options?.signal,
      onOutput: options?.onOutput,
    });
  },
  /**
   * Run a single whois query so callers asking about ownership/registrar
   * never trigger an nmap scan as a side effect.
   */
  async "whois.lookup"(args, options) {
    const host = parseHost(requireString(args, "target"));
    return spawnArgv({
      command: "whois",
      argv: [host.value],
      timeoutMs: 60_000,
      signal: options?.signal,
      onOutput: options?.onOutput,
    });
  },
  async "pentest.recon"(args, options) {
    const host = parseHost(requireString(args, "target"));
    // Per-step opt-in flags so callers can ask for ONLY the recon they
    // need. When no flags are supplied the legacy behavior runs (all
    // three steps), preserving backwards compatibility for prompts that
    // expect a full sweep.
    const wantWhois = args.whois !== false;
    const wantDns = args.dns !== false;
    const wantNmap = args.nmap !== false;
    const allSteps: Array<{
      key: "whois" | "dns" | "nmap";
      command: string;
      argv: string[];
    }> = [
      { key: "whois", command: "whois", argv: [host.value] },
      {
        key: "dns",
        command: "dig",
        argv: [host.value, "ANY", "+noall", "+answer"],
      },
      {
        key: "nmap",
        command: "nmap",
        // -sS = stealth SYN scan (the professional default). It needs raw
        // sockets, so runNmapScan wraps it in sudo / elevation and falls
        // back to an unprivileged TCP connect scan (-sT) when privilege
        // can't be obtained.
        argv: ["-sS", "-sV", "--top-ports", "100", host.value],
      },
    ];
    const steps = allSteps.filter((step) => {
      if (step.key === "whois") return wantWhois;
      if (step.key === "dns") return wantDns;
      if (step.key === "nmap") return wantNmap;
      return true;
    });
    if (steps.length === 0) {
      return {
        ok: false,
        output:
          "pentest.recon: no steps requested. Set at least one of whois|dns|nmap to true, or omit them all for a full sweep.",
        exitCode: 1,
      };
    }

    // Allocate one shared artifact file so the user can pop the full
    // recon transcript open in the Ctrl+O pager. Without this, the
    // viewport would have only the model-facing summary and the pager
    // would render "(no artifact file — only the summary is available)".
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const artifactDir = join(homedir(), ".clai", "outputs");
    let artifactPath: string | undefined;
    try {
      await mkdir(artifactDir, { recursive: true });
      const safeHost = host.value.replace(/[^a-z0-9_.-]+/gi, "-");
      artifactPath = join(
        artifactDir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-recon-${safeHost}.txt`,
      );
    } catch {
      // Falling back to no artifact is fine; the model still sees the
      // summary even if the artifact couldn't be created.
      artifactPath = undefined;
    }

    const outputs: string[] = [];
    const transcript: string[] = [];
    for (const step of steps) {
      if (options?.signal?.aborted) break;
      const display = `${step.command} ${step.argv.join(" ")}`;
      transcript.push(`$ ${display}`);
      // Announce each sub-step so users see progress through long recons.
      options?.onOutput?.(`\n$ ${display}\n`, "stdout");
      const result =
        step.key === "nmap"
          ? // Route the scan through the privilege-aware runner so the
            // stealth SYN scan is elevated (sudo/elevation) and falls back
            // to a connect scan when privilege isn't available.
            await runNmapScan(step.argv, options)
          : await spawnArgv({
              command: step.command,
              argv: step.argv,
              timeoutMs: 180_000,
              signal: options?.signal,
              onOutput: options?.onOutput,
            });
      outputs.push(result.output);
      transcript.push(result.output);
      if (options?.signal?.aborted) break;
    }

    if (artifactPath) {
      const body = transcript.join("\n\n");
      try {
        await writeFile(artifactPath, body, "utf8");
      } catch {
        artifactPath = undefined;
      }
    }

    return {
      ok: !options?.signal?.aborted,
      output: options?.signal?.aborted
        ? `${outputs.join("\n\n")}\n\nCommand aborted.`.trim()
        : outputs.join("\n\n"),
      exitCode: options?.signal?.aborted ? 130 : 0,
      ...(artifactPath ? { outputPath: artifactPath } : {}),
    };
  },
  async "tool.batch"(args, options) {
    return runToolBatch(args, options);
  },
  async "net.context"() {
    return getNetworkContext();
  },
  async "net.pingSweep"(args) {
    const target = requireString(args, "target");
    return pingSweep({
      target,
      method: optionalString(args, "method") as
        | "auto"
        | "nmap"
        | "arp"
        | "native"
        | undefined,
      timeoutMs: optionalNumber(args, "timeoutMs"),
    });
  },
  async "tool.check"(args) {
    return toolCheckHandler(args);
  },
  async "image.ocr"(args, options) {
    return imageOcr(args, options);
  },
  async "pdf.read"(args, options) {
    return pdfRead(args, options);
  },
  async "shell.start"(args) {
    const command = requireString(args, "command");
    return jobManager.startJob(command, {
      cwd: optionalString(args, "cwd"),
      name: optionalString(args, "name"),
    });
  },
  async "shell.jobs"() {
    return jobManager.listJobs();
  },
  async "shell.tail"(args) {
    return jobManager.tailJob(
      requireString(args, "id"),
      optionalNumber(args, "bytes"),
    );
  },
  async "shell.stop"(args) {
    return jobManager.stopJob(requireString(args, "id"));
  },
  async "fs.edit"(args) {
    return fsEdit(
      requireString(args, "path"),
      requireString(args, "oldText"),
      requireString(args, "newText"),
      optionalNumber(args, "expectedReplacements"),
    );
  },
  async "fs.delete"(args) {
    return fsDelete(
      requireString(args, "path"),
      typeof args.recursive === "boolean" ? args.recursive : undefined,
    );
  },
};

export function availableToolNames(): string[] {
  return Object.keys(toolRegistry);
}

/**
 * Build a shell command string from a bare-command tool call. Models often
 * emit the binary as the tool name (`sed`, `awk`, `git`, …) and stuff the
 * rest into a `command`/`args`/`argv` field — or split it across fields. We
 * recover a runnable command from whatever shape arrived.
 */
function buildShellCommandFromCall(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  const asText = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) {
      const parts = value
        .filter((v) => typeof v === "string" || typeof v === "number")
        .map((v) => String(v));
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    return undefined;
  };

  let rest =
    asText(args.command) ??
    asText(args.cmd) ??
    asText(args.args) ??
    asText(args.arguments) ??
    asText(args.argv) ??
    asText(args.input);

  if (rest === undefined) {
    // Last resort: concatenate scalar arg values (skipping execution knobs)
    // in insertion order so e.g. {"expression":"s/a/b/","file":"x"} still runs.
    const skip = new Set(["cwd", "timeoutMs", "iOwnThis", "own"]);
    const parts: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (skip.has(key)) continue;
      const text = asText(value);
      if (text) parts.push(text);
    }
    rest = parts.join(" ");
  }

  const trimmedName = name.trim();
  const trimmedRest = (rest ?? "").trim();
  if (!trimmedRest) return trimmedName || undefined;
  // Avoid a doubled binary when `rest` already begins with the tool name.
  const firstToken = trimmedRest.split(/\s+/)[0];
  if (!trimmedName.includes(" ") && firstToken === trimmedName) {
    return trimmedRest;
  }
  return `${trimmedName} ${trimmedRest}`.trim();
}

/**
 * Normalize a tool call before dispatch. If the name is not a registered
 * tool but looks like a bare shell command (no `namespace.` dot — clai tools
 * are all namespaced, e.g. `fs.read`, `web.search`), rewrite it into a
 * `shell.exec` call instead of dead-ending on "Unknown tool: sed". The
 * rewritten call still flows through the normal shell safety classifier, so
 * dangerous commands are gated exactly as a hand-written shell.exec would be.
 */
export function normalizeToolCall(call: ToolCall): ToolCall {
  if (toolRegistry[call.name]) return call;
  const name = typeof call.name === "string" ? call.name.trim() : "";
  // Leave genuinely unknown namespaced tools (e.g. a typo'd "fs.reed") to
  // surface a clear error rather than guessing at a shell command.
  if (!name || name.includes(".") || name.includes("/")) return call;
  const args = call.args ?? {};
  const command = buildShellCommandFromCall(name, args);
  if (!command) return call;
  const shellArgs: Record<string, unknown> = { command };
  if (typeof args.cwd === "string") shellArgs.cwd = args.cwd;
  if (typeof args.timeoutMs === "number") shellArgs.timeoutMs = args.timeoutMs;
  return { name: "shell.exec", args: shellArgs };
}

/**
 * Pull the result URLs out of a web.search success output. The output is a
 * one-line summary followed by a JSON `{ results: [{url, ...}] }` block; we
 * parse from the first brace. Falls back to a regex scan if JSON parsing
 * fails so a slightly different shape still yields fetchable URLs.
 */
export function extractResultUrls(output: string): string[] {
  const brace = output.indexOf("{");
  if (brace >= 0) {
    try {
      const parsed = JSON.parse(output.slice(brace)) as {
        results?: Array<{ url?: unknown }>;
      };
      const urls = (parsed.results ?? [])
        .map((r) => (typeof r.url === "string" ? r.url : ""))
        .filter((u) => u.startsWith("http://") || u.startsWith("https://"));
      if (urls.length > 0) return urls;
    } catch {
      // fall through to regex
    }
  }
  const matches = output.match(/https?:\/\/[^\s"]+/g);
  return matches ? matches.map((u) => u.replace(/[",]+$/, "")) : [];
}

export async function runToolCall(
  call: ToolCall,
  options: ToolRunOptions = {},
): Promise<ToolResult> {
  const normalized = normalizeToolCall(call);
  const handler = toolRegistry[normalized.name];
  if (!handler) {
    throw new Error(`Unknown tool: ${normalized.name}`);
  }
  return handler(normalized.args, options);
}

/**
 * Tools that `tool.batch` is allowed to invoke. Limited to read-only
 * operations so the batch runner cannot escalate into shell execution
 * or mutating HTTP methods. http.fetch is allowed but downstream
 * GET/HEAD enforcement still happens in the classifier when individual
 * calls are routed.
 */
const BATCH_SAFE_TOOLS = new Set([
  "fs.read",
  "fs.list",
  "fs.search",
  "http.fetch",
  "sysinfo",
  "dns.lookup",
  "whois.lookup",
  "net.context",
  "tool.check",
  "image.ocr",
  "pdf.read",
  "web.search",
  "web.fetch",
]);

const BATCH_MAX_CALLS = 8;
const BATCH_DEFAULT_CONCURRENCY = 3;
const BATCH_MAX_CONCURRENCY = 4;

interface BatchCallSpec {
  name: string;
  args: Record<string, unknown>;
}

function parseBatchCalls(value: unknown): BatchCallSpec[] {
  if (!Array.isArray(value)) {
    throw new Error("tool.batch expects { calls: [{name, args}, ...] }");
  }
  if (value.length === 0) {
    throw new Error("tool.batch requires at least one call");
  }
  if (value.length > BATCH_MAX_CALLS) {
    throw new Error(
      `tool.batch accepts at most ${BATCH_MAX_CALLS} calls per invocation`,
    );
  }
  return value.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      typeof (entry as { args?: unknown }).args !== "object" ||
      (entry as { args?: unknown }).args === null
    ) {
      throw new Error(
        `tool.batch call #${index} must be { name: string, args: object }`,
      );
    }
    const { name, args } = entry as {
      name: string;
      args: Record<string, unknown>;
    };
    if (!BATCH_SAFE_TOOLS.has(name)) {
      throw new Error(
        `tool.batch refuses to run "${name}" — only read-only tools are allowed (${[...BATCH_SAFE_TOOLS].join(", ")})`,
      );
    }
    return { name, args };
  });
}

async function runWithLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const runners: Promise<void>[] = [];
  for (let n = 0; n < Math.min(limit, queue.length); n += 1) {
    runners.push(
      (async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) break;
          await worker(next.item, next.index);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

interface BatchOutcome {
  index: number;
  name: string;
  ok: boolean;
  output: string;
  exitCode?: number | undefined;
  error?: string | undefined;
}

async function runToolBatch(
  args: Record<string, unknown>,
  options?: ToolRunOptions,
): Promise<ToolResult> {
  const calls = parseBatchCalls(args.calls);
  // Re-classify each child call so confirm/block tools (eg http.fetch POST,
  // public scans without scope) cannot ride in on tool.batch's safe label.
  const scope = await loadScope().catch(() => undefined);
  for (const spec of calls) {
    const decision = classifyToolCall(
      { name: spec.name, args: spec.args },
      { scope },
    );
    if (decision.level !== "safe") {
      throw new Error(
        `tool.batch refuses ${spec.name}: ${decision.reason} (only safe-classified calls are allowed inside a batch)`,
      );
    }
  }
  const concurrency = Math.max(
    1,
    Math.min(
      typeof args.concurrency === "number"
        ? Math.floor(args.concurrency)
        : BATCH_DEFAULT_CONCURRENCY,
      BATCH_MAX_CONCURRENCY,
    ),
  );
  const outcomes: BatchOutcome[] = new Array(calls.length);
  await runWithLimit(calls, concurrency, async (spec, index) => {
    if (options?.signal?.aborted) {
      outcomes[index] = {
        index,
        name: spec.name,
        ok: false,
        output: "Aborted before execution.",
        exitCode: 130,
      };
      return;
    }
    try {
      const result = await runToolCall(
        { name: spec.name, args: spec.args },
        // Skip onOutput streaming: batch results are summarized after all
        // members complete to keep the live preview readable.
        { signal: options?.signal },
      );
      outcomes[index] = {
        index,
        name: spec.name,
        ok: result.ok,
        output: result.output,
        exitCode: result.exitCode,
      };
    } catch (error) {
      outcomes[index] = {
        index,
        name: spec.name,
        ok: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const allOk = outcomes.every((outcome) => outcome.ok);
  const sections = outcomes.map((outcome) => {
    const status = outcome.ok ? "ok" : "fail";
    const head = `── #${outcome.index + 1} ${outcome.name} [${status}${outcome.exitCode !== undefined ? ` exit=${outcome.exitCode}` : ""}]`;
    const body = outcome.error
      ? `error: ${outcome.error}`
      : outcome.output.trim();
    return `${head}\n${body}`;
  });
  return {
    ok: allOk,
    output: sections.join("\n\n"),
    exitCode: allOk ? 0 : 1,
  };
}
