import { detectSystem } from "../os/detect.js";
import {
  detectPackageManager,
  assertSafePackageName,
  commandAvailable,
} from "../os/pkgmgr.js";
import { safeCwd } from "../os/cwd.js";
import type { ChatImage, ToolCall, ToolResult } from "../types.js";
import {
  fsEdit,
  fsDelete,
  fsList,
  fsRead,
  fsSearch,
  fsWrite,
  fsWriteMany,
  fsReplaceLines,
  fsAppend,
  type FileWrite,
} from "./fs.js";
import { httpFetch } from "./http.js";
import {
  createInteractiveSessionHandlers,
  INTERACTIVE_SESSION_TOOL_NAMES,
} from "./interactive-session-tools.js";
import { shellExec, spawnArgv } from "./shell.js";
import {
  isLongQuietInstallOrScaffoldCommand,
  isLongRunningTestOrBuildCommand,
} from "../agent/task-evidence.js";
import { imageOcr, imageView } from "./image.js";
import { pdfRead } from "./pdf.js";
import { webFetch } from "./web/fetch.js";
import { webSearch } from "./web/search.js";
import {
  RESPONSE_MODES,
  SEARCH_TIMEOUT_MS,
  type ResponseMode,
} from "./web/types.js";
import { classifyToolCall } from "../safety/classifier.js";
import { instructionsRecordTool } from "./instructions.js";
import { skillListTool, skillLoadTool } from "./skills.js";
import { loadScopeForSession } from "../store/scope.js";
import {
  parseHost,
  parsePortSpec,
  parseLegacyFlags,
  normalizeScanProfile,
  profileToNmapArgs,
  nmapScanNeedsPrivilege,
  toConnectScanArgv,
  withNmapSkipDiscovery,
} from "./validate.js";
import { getNetworkContext } from "./network-context.js";
import { pingSweep } from "./net-ping-sweep.js";
import { toolCheckHandler } from "./capabilities.js";
import { wordlistFind } from "./wordlists.js";
import {
  jobManager,
  type BackgroundSpawnSpec,
  type StartJobOptions,
} from "./jobs.js";
import { resolveShellExecBackgroundPolicy } from "./command-intent.js";
import { packageBinaryName } from "./package-binary.js";
import { resolveNmapTimeoutPolicy, runNmapScan } from "./nmap-runner.js";
import { compareAuthorizationContexts, discoverWebSurface, enumerateApi } from "./pentest-workflows.js";
import { nativeDnsLookup } from "./dns-native.js";
import { nativeWhoisLookup } from "./whois-native.js";
import { type ToolRunOptions, type ToolHandler } from "./tool-types.js";
import {
  elidedStubReuseMessage,
  findElidedStubArg,
} from "../agent/message-slim.js";
import { fromWireName, sanitizeToolName } from "../llm/tool-protocol.js";
import { NON_REGISTRY_TOOL_NAMES } from "./definitions.js";
import {
  prepareElevatedBackgroundCommand,
  preparePrivilegedBackgroundArgv,
  tryRunElevatedWithoutTty,
} from "./elevated-shell.js";
import {
  getAllowInteractiveStdinInherit,
  looksInteractiveStdin,
} from "./shell.js";
import {
  compileBatchFailMode,
  evaluateCancelTargets,
  formatBatchCancelReason,
  parseBatchFailPolicy,
  parseCancelOnFailField,
  resolveBatchCallId,
  type BatchCallFailMeta,
  type BatchFailMode,
} from "./batch-fail-policy.js";

export type { ToolRunOptions, ToolHandler };
export {
  parseBatchFailPolicy,
  compileBatchFailMode,
  evaluateCancelTargets,
  formatBatchCancelReason,
} from "./batch-fail-policy.js";

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tool argument "${key}" must be a non-empty string`);
  }
  return value;
}

/** Like requireString but allows empty string (e.g. replaceLines delete). */
function requireStringAllowEmpty(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Tool argument "${key}" must be a string`);
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Handle string numbers (e.g. "300000" from JSON) and coerce to number
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool argument "${key}" must be a finite number`);
  }
  return value;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function responderJobOptions(options?: ToolRunOptions): StartJobOptions {
  const responderLeaseId = jobManager.getResponderLeaseId(options?.sessionId);
  return {
    ...(options?.sessionId ? { ownerSessionId: options.sessionId } : {}),
    ...(options?.taskId ? { taskId: options.taskId } : {}),
    ...(options?.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
    ...(options?.delegationId ? { delegationId: options.delegationId } : {}),
    ...(options?.wakeOnCompletion !== undefined ? { wakeOnCompletion: options.wakeOnCompletion } : {}),
    ...(options?.monitor !== undefined ? { monitor: options.monitor } : {}),
    ...(responderLeaseId ? { responderLeaseId } : {}),
  };
}

export interface ScanResourceEstimate {
  profile: "standard" | "deep" | "full";
  estimatedSeconds: number;
  timeoutMs: number;
  durableRecommended: boolean;
}

export function estimateScanResources(argv: readonly string[]): ScanResourceEstimate {
  const policy = resolveNmapTimeoutPolicy(argv, {});
  const estimatedSeconds = policy.depth === "full" ? 1_800 : policy.depth === "deep" ? 600 : 120;
  return {
    profile: policy.depth,
    estimatedSeconds,
    timeoutMs: policy.timeoutMs,
    durableRecommended: policy.depth !== "standard",
  };
}

type PreparedNmapJob =
  | { prepared: true; spec: BackgroundSpawnSpec }
  | { prepared: false; result: ToolResult };

async function prepareDurableNmapJob(
  argv: string[],
  options: ToolRunOptions | undefined,
  prompt: string,
): Promise<PreparedNmapJob> {
  if (!nmapScanNeedsPrivilege(argv)) {
    return { prepared: true, spec: { command: "nmap", argv: [...argv] } };
  }
  const elevated = await preparePrivilegedBackgroundArgv("nmap", argv, {
    signal: options?.signal,
    onOutput: options?.onOutput,
    requestSecret: options?.requestSecret,
    title: "Administrator access for nmap",
    prompt,
  });
  if (elevated.prepared || options?.signal?.aborted) return elevated;
  if (argv.includes("-sU") || argv.includes("-sO")) {
    return {
      prepared: false,
      result: {
        ...elevated.result,
        output:
          `${elevated.result.output}\n` +
          "The requested UDP/protocol scan has no equivalent unprivileged fallback. Authentication will not be reopened automatically; choose a TCP connect scan explicitly to continue without elevation.",
      },
    };
  }
  const fallbackArgv = withNmapSkipDiscovery(toConnectScanArgv(argv));
  options?.onOutput?.(
    "\nAdministrator scan was cancelled or unavailable. Starting one unprivileged TCP connect fallback (-sT -Pn); authentication will not be requested again.\n",
    "stderr",
  );
  return {
    prepared: true,
    spec: { command: "nmap", argv: fallbackArgv },
  };
}

/** nmap argv for pentest.recon — ports configurable (default top-100). */
export function buildPentestReconNmapArgv(
  args: Record<string, unknown>,
  host: string,
): string[] {
  const argv = ["-sS", "-sV"];
  const full = args.full === true || args.full === "true";
  const portsRaw =
    typeof args.ports === "string" && args.ports.trim()
      ? args.ports.trim()
      : undefined;
  // "top-1000" / "top ports 1000" style specs map to --top-ports, not -p.
  const topPortsSpec = portsRaw
    ? /^top[\s_-]*(?:ports?[\s_-]*)?(\d{1,5})$/i.exec(portsRaw)
    : null;
  const ports = portsRaw && !topPortsSpec ? portsRaw : undefined;
  let topPorts: number | undefined;
  if (typeof args.topPorts === "number" && Number.isFinite(args.topPorts)) {
    topPorts = Math.max(1, Math.min(65535, Math.floor(args.topPorts)));
  } else if (typeof args.topPorts === "string" && /^\d+$/.test(args.topPorts)) {
    topPorts = Math.max(1, Math.min(65535, Number(args.topPorts)));
  }
  if (topPortsSpec && topPorts === undefined) {
    topPorts = Math.max(1, Math.min(65535, Number(topPortsSpec[1])));
  }
  if (full) {
    argv.push("-p-");
  } else if (ports) {
    const spec = parsePortSpec(ports);
    argv.push("-p", spec);
  } else {
    argv.push("--top-ports", String(topPorts ?? 100));
  }
  argv.push(host);
  return argv;
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

export const toolRegistry: Record<string, ToolHandler> = {
  ...createInteractiveSessionHandlers(),
  async "shell.exec"(args, options) {
    const command = requireString(args, "command");
    const requestedTimeoutMs = optionalNumber(args, "timeoutMs");
    const policy = resolveShellExecBackgroundPolicy({
      command,
      background: args.background,
      responder: args.responder,
    });
    const {
      backgroundMode,
      costReason,
      wantsBackground,
      responder,
    } = policy;
    if (wantsBackground) {
      const elevated = await prepareElevatedBackgroundCommand(command, {
        signal: options?.signal,
        onOutput: options?.onOutput,
        requestSecret: options?.requestSecret,
      });
      if (elevated && !elevated.prepared) return elevated.result;
      const job = await jobManager.startJob(
        elevated?.prepared ? elevated.spec : command,
        {
          cwd: optionalString(args, "cwd"),
          ...responderJobOptions(options),
          responder,
          wakeOnCompletion: responder,
        },
      );
      if (job.ok) {
        const autoBackgrounded = backgroundMode === "auto";
        const timeoutNote =
          autoBackgrounded && requestedTimeoutMs !== undefined
            ? `\n\nNote: timeoutMs=${requestedTimeoutMs} does not apply — this command was auto-backgrounded${costReason ? ` (${costReason})` : ""}. Pass background:"never" to run it in the foreground with your timeout.`
            : "";
        const costNote =
          autoBackgrounded && costReason
            ? `\n\nAuto-backgrounded because: ${costReason}. Pass background:"never" to force foreground.`
            : "";
        return {
          ...job,
          output: `${job.output}${costNote}${timeoutNote}`,
        };
      }
      return job;
    }
    let timeoutMs = requestedTimeoutMs;
    // Handle seconds vs milliseconds confusion for long-running commands
    // If model sends 300 thinking 300s, but code expects ms, convert small values to ms
    if (
      timeoutMs !== undefined &&
      timeoutMs > 0 &&
      timeoutMs < 1000 &&
      (isLongQuietInstallOrScaffoldCommand(command) ||
        isLongRunningTestOrBuildCommand(command))
    ) {
      timeoutMs = timeoutMs * 1000;
    }
    timeoutMs =
      timeoutMs ??
      (isLongQuietInstallOrScaffoldCommand(command)
        ? 15 * 60_000
        : isLongRunningTestOrBuildCommand(command)
          ? 120_000
          : undefined);

    // Password tools must never steal the TTY in OpenTUI (freezes Esc/clicks).
    // Prefer secure modal + sudo -S; otherwise refuse interactive elevation.
    if (looksInteractiveStdin(command)) {
      const elevated = await tryRunElevatedWithoutTty(command, {
        cwd: optionalString(args, "cwd"),
        timeoutMs,
        signal: options?.signal,
        onOutput: options?.onOutput,
        requestSecret: options?.requestSecret,
      });
      if (elevated) return elevated;
      const isRoot = process.getuid?.() === 0;
      if (!isRoot && !getAllowInteractiveStdinInherit()) {
        return {
          ok: false,
          exitCode: 1,
          output:
            "This command needs an interactive password prompt, which this frontend cannot show without freezing the UI. " +
            "Run it in an interactive session (terminal.start, then answer the prompt via terminal.send), " +
            "or re-run from the clai TUI where the secure password modal is available.",
        };
      }
    }

    return shellExec({
      command,
      cwd: optionalString(args, "cwd"),
      timeoutMs,
      signal: options?.signal,
      onOutput: options?.onOutput,
      // Explicit: never inherit unless classic REPL policy allows it.
      interactiveStdin: getAllowInteractiveStdinInherit() ? "auto" : false,
    });
  },
  async "fs.read"(args, options) {
    return fsRead(requireString(args, "path"), {
      maxBytes: optionalNumber(args, "maxBytes"),
      offset: optionalNumber(args, "offset"),
      limit: optionalNumber(args, "limit"),
      startLine: optionalNumber(args, "startLine"),
      endLine: optionalNumber(args, "endLine"),
      pattern: optionalString(args, "pattern"),
      context: optionalNumber(args, "context"),
      maxMatches: optionalNumber(args, "maxMatches"),
      caseInsensitive: optionalBoolean(args, "caseInsensitive"),
      confirmed: options?.confirmed,
    });
  },
  async "fs.write"(args, options) {
    return fsWrite(
      requireString(args, "path"),
      requireString(args, "content"),
      { confirmed: options?.confirmed },
    );
  },
  async "fs.writeMany"(args, options) {
    const raw = args.files;
    if (!Array.isArray(raw)) {
      throw new Error(
        'fs.writeMany requires a "files" array of { path, content } objects',
      );
    }
    const files = raw as FileWrite[];
    return fsWriteMany(files, { confirmed: options?.confirmed });
  },
  async "fs.list"(args, options) {
    return fsList(optionalString(args, "path") ?? safeCwd(), {
      maxEntries: optionalNumber(args, "maxEntries"),
      confirmed: options?.confirmed,
    });
  },
  async "fs.search"(args, options) {
    return fsSearch(
      requireString(args, "pattern"),
      optionalString(args, "path"),
      {
        confirmed: options?.confirmed,
        maxMatches: optionalNumber(args, "maxMatches"),
        maxPerFile: optionalNumber(args, "maxPerFile"),
        glob: optionalString(args, "glob"),
        caseInsensitive: optionalBoolean(args, "caseInsensitive"),
        fixedString: optionalBoolean(args, "fixedString"),
        context: optionalNumber(args, "context"),
        filesOnly: optionalBoolean(args, "filesOnly"),
        hidden: optionalBoolean(args, "hidden"),
        timeoutMs: optionalNumber(args, "timeoutMs"),
      },
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
    // dig/whois are never required — built-in dns.lookup / whois.lookup cover them.
    const nativeCovered = new Set([
      "dig",
      "whois",
      "bind",
      "bind9",
      "dnsutils",
      "bind-utils",
      "nslookup",
    ]);
    if (nativeCovered.has(tool.toLowerCase()) || nativeCovered.has(binary.toLowerCase())) {
      return {
        ok: true,
        output:
          `${tool} is optional. Use built-in dns.lookup (Node resolver + DNS-over-HTTPS) ` +
          `and whois.lookup (RDAP + port-43) — no system binary install required.`,
        exitCode: 0,
      };
    }
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
      timeoutMs: optionalNumber(args, "timeoutMs") ?? 600_000,
      signal: options?.signal,
      onOutput: options?.onOutput,
    });
  },
  async "net.scan"(args, options) {
    const host = parseHost(requireString(args, "target"));
    const portsRaw = optionalString(args, "ports");
    // Accept natural "top ports" intents (top-1000, top1000, top-ports 1000,
    // "top 1000") as a topPorts profile instead of rejecting them as an
    // invalid literal port spec.
    const topPortsMatch = portsRaw
      ? /^top[\s_-]*(?:ports?[\s_-]*)?(\d{1,5})$/i.exec(portsRaw.trim())
      : null;
    const ports =
      portsRaw && !topPortsMatch ? parsePortSpec(portsRaw) : undefined;
    let profile = normalizeScanProfile(args.profile);
    if (topPortsMatch) {
      const n = Math.max(1, Math.min(65535, Number(topPortsMatch[1])));
      profile = { ...(profile ?? {}), topPorts: profile?.topPorts ?? n };
    }

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
    const estimate = estimateScanResources(argv);
    const durable = args.background === true || args.responder === true;
    if (durable) {
      const prepared = await prepareDurableNmapJob(
        argv,
        options,
        "Enter your password for the nmap raw-socket scan. It is sent only to sudo stdin and is never stored. Esc cancels.",
      );
      if (!prepared.prepared) return prepared.result;
      return jobManager.startJob(prepared.spec, {
        name: `nmap-${estimate.profile}-${host.value}`,
        profile: estimate.profile,
        estimatedSeconds: estimate.estimatedSeconds,
        ...responderJobOptions(options),
        responder: args.responder === true,
        wakeOnCompletion: args.responder === true,
        ...(options?.engagementAuthorization ? { authorization: options.engagementAuthorization } : {}),
      });
    }
    return runNmapScan(argv, options, optionalNumber(args, "timeoutMs"));
  },
  async "http.fetch"(args, options) {
    const headers =
      args.headers &&
      typeof args.headers === "object" &&
      !Array.isArray(args.headers)
        ? (args.headers as Record<string, string>)
        : undefined;
    const url = requireString(args, "url");
    const method = (optionalString(args, "method") ?? "GET").toUpperCase();
    // Local app verify: loopback GET/HEAD is the owner's own process — auto-own
    // so models are not stuck without iOwnThis. Mutating methods and non-loopback
    // private/metadata addresses still require explicit ownership.
    let iOwnThis = args.iOwnThis === true || args.own === true;
    // Keep the caller's host (localhost). httpFetch dual-stacks 127.0.0.1/::1
    // on connection failure — rewriting to 127.0.0.1 alone broke Vite on
    // IPv6-only macOS binds while the browser still worked.
    if (!iOwnThis && (method === "GET" || method === "HEAD")) {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        if (
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "::1" ||
          host === "localhost.localdomain" ||
          host === "ip6-localhost" ||
          /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
        ) {
          iOwnThis = true;
        }
      } catch {
        /* invalid URL handled inside httpFetch */
      }
    }
    const insecureTls =
      args.insecureTls === true ||
      args.tlsInsecure === true ||
      args.insecure === true;
    return httpFetch(url, {
      method: optionalString(args, "method"),
      body: optionalString(args, "body"),
      headers,
      maxBytes: optionalNumber(args, "maxBytes"),
      iOwnThis,
      retries: optionalNumber(args, "retries"),
      timeoutMs: optionalNumber(args, "timeoutMs"),
      responseMode:
        optionalString(args, "responseMode") === "readable" ? "readable" : "raw",
      responsePart: (() => {
        const part = optionalString(args, "responsePart");
        return part === "headers" || part === "body" ? part : "full";
      })(),
      topLines: optionalNumber(args, "topLines"),
      bottomLines: optionalNumber(args, "bottomLines"),
      maxOutputBytes: optionalNumber(args, "maxOutputBytes"),
      forwardSensitiveHeaders:
        optionalBoolean(args, "forwardSensitiveHeaders") ?? false,
      insecureTls,
      signal: options?.signal,
      // Never attach engagement hop checks for owned loopback — leftover
      // pentest scope must not fail local app verify.
      authorizeHop: iOwnThis ? undefined : options?.authorizeNetworkHop,
    });
  },
  async "web.search"(args, options) {
    const query = requireString(args, "query");
    const maxResults = optionalNumber(args, "maxResults");
    const selectedTimeoutMs = optionalNumber(args, "timeoutMs") ?? SEARCH_TIMEOUT_MS;
    // Search providers, fallback attempts, and optional fetchTop page reads
    // share one wall-clock deadline rather than each resetting the budget.
    const deadline = Date.now() + selectedTimeoutMs;
    const remainingMs = (): number => Math.max(0, deadline - Date.now());
    const result = await webSearch(
      {
        query,
        ...(maxResults !== undefined ? { maxResults } : {}),
      },
      {
        ...(options?.signal ? { signal: options.signal } : {}),
        timeoutMs: Math.max(1, remainingMs()),
      },
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
    if (remainingMs() <= 0) {
      return {
        ...result,
        output: `${result.output}\n\n(fetchTop skipped: web.search deadline exhausted)`,
      };
    }

    // Heartbeats reset the runner's stall watchdog (web.search emits no
    // stdout of its own). Honor turn cancel between pages so Esc/Ctrl+C
    // does not wait for every fetchTop page to time out.
    if (options?.signal?.aborted) {
      return {
        ...result,
        ok: false,
        output: `${result.output}\n\n(aborted before fetchTop)`,
        exitCode: 130,
      };
    }
    options?.onOutput?.(
      `fetchTop: reading ${urls.length} page(s)…\n`,
      "stdout",
    );

    const pages = await Promise.all(
      urls.map(async (url, i) => {
        if (options?.signal?.aborted) {
          return `── PAGE: ${url} (aborted)`;
        }
        options?.onOutput?.(
          `fetchTop [${i + 1}/${urls.length}]: ${url}\n`,
          "stdout",
        );
        try {
          const pageBudgetMs = remainingMs();
          if (pageBudgetMs <= 0) {
            return `── PAGE: ${url} (skipped: web.search deadline exhausted)`;
          }
          const page = await webFetch(
            {
              url,
              responseMode: "readable",
              includeHeaders: false,
              timeoutMs: pageBudgetMs,
            },
            { ...(options?.signal ? { signal: options.signal } : {}) },
          );
          // Never truncate page bodies for the tool result — the UI pager and
          // artifacts must keep the full text. Model context is still budgeted
          // separately in formatToolContext / context compaction.
          const text = page.output.trim();
          return `── PAGE: ${url} ${page.ok ? "" : "(fetch failed)"}\n${text}`;
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
    const timeoutMs = optionalNumber(args, "timeoutMs");
    if (timeoutMs !== undefined) fetchArgs.timeoutMs = timeoutMs;
    const includeHeaders = optionalBoolean(args, "includeHeaders");
    fetchArgs.includeHeaders = includeHeaders ?? false;
    const includeTls = optionalBoolean(args, "includeTls");
    fetchArgs.includeTls = includeTls ?? false;
    const includeTiming = optionalBoolean(args, "includeTiming");
    fetchArgs.includeTiming = includeTiming ?? false;
    const includeRedirectChain = optionalBoolean(args, "includeRedirectChain");
    fetchArgs.includeRedirectChain = includeRedirectChain ?? false;
    const responseMode = optionalResponseMode(args, "responseMode");
    if (responseMode !== undefined) fetchArgs.responseMode = responseMode;
    const responsePart = optionalString(args, "responsePart");
    if (
      responsePart === "full" ||
      responsePart === "headers" ||
      responsePart === "body"
    ) {
      fetchArgs.responsePart = responsePart;
      if (responsePart === "headers") fetchArgs.includeHeaders = true;
    }
    const topLines = optionalNumber(args, "topLines");
    if (topLines !== undefined) fetchArgs.topLines = topLines;
    const bottomLines = optionalNumber(args, "bottomLines");
    if (bottomLines !== undefined) fetchArgs.bottomLines = bottomLines;
    const maxOutputBytes = optionalNumber(args, "maxOutputBytes");
    if (maxOutputBytes !== undefined) fetchArgs.maxOutputBytes = maxOutputBytes;
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
    return nativeDnsLookup(host.value, recordRaw as Parameters<typeof nativeDnsLookup>[1]);
  },
  /**
   * Run a single whois query so callers asking about ownership/registrar
   * never trigger an nmap scan as a side effect.
   */
  async "whois.lookup"(args, options) {
    const host = parseHost(requireString(args, "target"));
    // Keep whois short-lived: many servers hang or buffer until close. A hard
    // 20s cap beats the outer 60s "no output" stall watchdog aborting mid-recon.
    return nativeWhoisLookup(host.value);
  },
  async "pentest.recon"(args, options) {
    const host = parseHost(requireString(args, "target"));
    const wantWhois = args.whois !== false;
    const wantDns = args.dns !== false;
    const wantNmap = args.nmap !== false;
    const nmapArgv = buildPentestReconNmapArgv(args, host.value);
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
        argv: nmapArgv,
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
    const { getArtifactDir } = await import("../store/paths.js");
    const artifactDir = getArtifactDir();
    let artifactPath: string | undefined;
    try {
      await mkdir(artifactDir, { recursive: true, mode: 0o700 });
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
    let anyOk = false;
    const userAborted = (): boolean => Boolean(options?.signal?.aborted);

    const runStep = async (step: (typeof steps)[number]): Promise<{ key: string; display: string; result: ToolResult }> => {
      const display = `${step.command} ${step.argv.join(" ")}`;
      options?.onOutput?.(`\n$ ${display}\n`, "stdout");
      const beat = setInterval(() => {
        options?.onOutput?.(`[recon] ${step.key} still running…\n`, "stdout");
      }, 5_000);
      (beat as unknown as { unref?: () => void }).unref?.();
      try {
        if (step.key === "nmap") {
          const estimate = estimateScanResources(step.argv);
          if (args.background === true || args.responder === true) {
            const prepared = await prepareDurableNmapJob(
              step.argv,
              options,
              "Enter your password for the durable nmap raw-socket scan. It is sent only to sudo stdin and is never stored. Esc cancels.",
            );
            const result = prepared.prepared
              ? await jobManager.startJob(prepared.spec, {
                  name: `recon-${estimate.profile}-${host.value}`,
                  profile: estimate.profile,
                  estimatedSeconds: estimate.estimatedSeconds,
                  ...responderJobOptions(options),
                  responder: args.responder === true,
                  wakeOnCompletion: args.responder === true,
                  ...(options?.engagementAuthorization ? { authorization: options.engagementAuthorization } : {}),
                })
              : prepared.result;
            return { key: step.key, display, result };
          }
          return {
            key: step.key,
            display,
            result: await runNmapScan(
              step.argv,
              options,
              optionalNumber(args, "timeoutMs"),
            ),
          };
        }
        if (step.key === "dns") {
          return {
            key: step.key,
            display: `native DNS ANY ${host.value}`,
            result: await nativeDnsLookup(host.value, "ANY"),
          };
        }
        if (step.key === "whois") {
          return {
            key: step.key,
            display: `native WHOIS ${host.value}`,
            result: await nativeWhoisLookup(host.value),
          };
        }
        const timeoutMs = step.key === "whois" ? 20_000 : 30_000;
        return {
          key: step.key,
          display,
          result: await spawnArgv({
            command: step.command,
            argv: step.argv,
            timeoutMs,
            signal: options?.signal,
            onOutput: options?.onOutput,
          }),
        };
      } catch (error) {
        return {
          key: step.key,
          display,
          result: { ok: false, output: `${step.key} error: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 },
        };
      } finally {
        clearInterval(beat);
      }
    };

    // Passive WHOIS/DNS and the selected scan run independently. Deep/full
    // scans return a durable job receipt immediately while passive results
    // continue to completion in this foreground turn.
    const completed = await Promise.all(steps.map(runStep));
    for (const { display, result } of completed) {
      transcript.push(`$ ${display}`, result.output);
      outputs.push(result.output);
      if (result.ok) anyOk = true;
    }

    if (artifactPath) {
      const body = transcript.join("\n\n");
      try {
        await writeFile(artifactPath, body, { encoding: "utf8", mode: 0o600 });
      } catch {
        artifactPath = undefined;
      }
    }

    // Passive successes remain useful evidence, but a requested nmap step
    // that failed authentication or never started must make the composite
    // operation fail rather than disguising it as a successful recon.
    const aborted = userAborted();
    const nmapResult = completed.find((entry) => entry.key === "nmap")?.result;
    const requestedScanFailed = wantNmap && Boolean(nmapResult && !nmapResult.ok);
    const backgroundJob = completed.find((entry) => entry.result.backgroundJob)?.result.backgroundJob;
    const output = outputs.join("\n\n");
    return {
      ok: !aborted && anyOk && !requestedScanFailed,
      output: aborted
        ? `${output}\n\nCommand aborted.`.trim()
        : requestedScanFailed
          ? `${output}\n\nThe requested nmap scan failed or was not started; passive recon results above are partial only.`.trim()
          : output,
      exitCode: aborted ? 130 : anyOk && !requestedScanFailed ? 0 : 1,
      ...(artifactPath ? { outputPath: artifactPath } : {}),
      ...(backgroundJob ? { backgroundJob } : {}),
    };
  },
  async "pentest.webDiscover"(args, options) {
    const paths = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === "string") : [];
    return discoverWebSurface(requireString(args, "baseUrl"), paths, options);
  },
  async "pentest.apiEnumerate"(args, options) {
    return enumerateApi(requireString(args, "specUrl"), options);
  },
  async "pentest.authCompare"(args, options) {
    const contexts = Array.isArray(args.contexts)
      ? args.contexts.filter((value): value is { label: string; headers: Record<string, string> } => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return false;
          const candidate = value as Record<string, unknown>;
          return typeof candidate.label === "string" && Boolean(candidate.headers) && typeof candidate.headers === "object" && !Array.isArray(candidate.headers);
        })
      : [];
    return compareAuthorizationContexts(requireString(args, "url"), contexts, options);
  },
  async "pentest.scanStatus"(args) {
    const offset = optionalNumber(args, "offset");
    const bytes = optionalNumber(args, "bytes");
    const stream = optionalString(args, "stream") as "stdout" | "stderr" | "combined" | undefined;
    return jobManager.tailJob(requireString(args, "id"), {
      ...(offset !== undefined ? { offset } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(stream !== undefined ? { stream } : {}),
    });
  },
  async "tool.batch"(args, options) {
    return runToolBatch(args, options);
  },
  async "net.context"() {
    return getNetworkContext();
  },
  async "net.pingSweep"(args, options) {
    const target = requireString(args, "target");
    return pingSweep(
      {
        target,
        method: optionalString(args, "method") as
          | "auto"
          | "nmap"
          | "arp"
          | "native"
          | undefined,
        timeoutMs: optionalNumber(args, "timeoutMs"),
      },
      { signal: options?.signal },
    );
  },
  async "tool.check"(args) {
    return toolCheckHandler(args);
  },
  async "wordlist.find"(args) {
    const expand = typeof args.expand === "boolean" ? args.expand : undefined;
    return wordlistFind({
      query: requireString(args, "query"),
      ...(expand !== undefined ? { expand } : {}),
    });
  },
  async "image.ocr"(args, options) {
    return imageOcr(args, options);
  },
  async "image.view"(args, options) {
    return imageView(args, options);
  },
  async "pdf.read"(args, options) {
    return pdfRead(args, options);
  },
  async "shell.start"(args, options) {
    const command = requireString(args, "command");
    const elevated = await prepareElevatedBackgroundCommand(command, {
      signal: options?.signal,
      onOutput: options?.onOutput,
      requestSecret: options?.requestSecret,
    });
    if (elevated && !elevated.prepared) return elevated.result;
    return jobManager.startJob(elevated?.prepared ? elevated.spec : command, {
      cwd: optionalString(args, "cwd"),
      name: optionalString(args, "name"),
      ...responderJobOptions(options),
      responder: false,
      wakeOnCompletion: false,
    });
  },
  async "shell.jobs"(_args, options) {
    return jobManager.listJobs(options?.sessionId);
  },
  async "shell.tail"(args) {
    const offset = optionalNumber(args, "offset");
    const bytes = optionalNumber(args, "bytes");
    const stream = optionalString(args, "stream") as
      | "stdout"
      | "stderr"
      | "combined"
      | undefined;
    return jobManager.tailJob(requireString(args, "id"), {
      ...(offset !== undefined ? { offset } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(stream !== undefined ? { stream } : {}),
    });
  },
  async "shell.stop"(args) {
    return jobManager.stopJob(requireString(args, "id"));
  },
  async "shell.wait"(args, options) {
    const timeoutMs = optionalNumber(args, "timeoutMs");
    return jobManager.waitForJob(requireString(args, "id"), {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  },
  async "fs.edit"(args, options) {
    return fsEdit(
      requireString(args, "path"),
      requireString(args, "oldText"),
      requireString(args, "newText"),
      optionalNumber(args, "expectedReplacements"),
      { confirmed: options?.confirmed },
    );
  },
  async "fs.replaceLines"(args, options) {
    // Empty content / delete:true removes the line range (X6).
    let content: string;
    if (args.delete === true) {
      content = "";
    } else if (typeof args.content === "string") {
      content = requireStringAllowEmpty(args, "content");
    } else {
      throw new Error(
        'Tool argument "content" must be a string (use "" or delete:true to delete the line range)',
      );
    }
    return fsReplaceLines(
      requireString(args, "path"),
      requireNumber(args, "startLine"),
      requireNumber(args, "endLine"),
      content,
      { confirmed: options?.confirmed },
    );
  },
  async "fs.append"(args, options) {
    return fsAppend(
      requireString(args, "path"),
      requireString(args, "content"),
      {
        position: optionalString(args, "position") as "start" | "end" | undefined,
        expectedPriorBytes: optionalNumber(args, "expectedPriorBytes"),
        confirmed: options?.confirmed,
      },
    );
  },
  async "fs.delete"(args, options) {
    return fsDelete(
      requireString(args, "path"),
      typeof args.recursive === "boolean" ? args.recursive : undefined,
      { confirmed: options?.confirmed },
    );
  },
  async "skill.list"(args) {
    return skillListTool(args);
  },
  async "skill.load"(args) {
    return skillLoadTool(args);
  },
  async "instructions.record"(args) {
    return instructionsRecordTool(args);
  },
};

export function availableToolNames(): string[] {
  return Object.keys(toolRegistry);
}

export function knownToolNames(): string[] {
  return [...Object.keys(toolRegistry), ...NON_REGISTRY_TOOL_NAMES].sort();
}

export function unknownToolErrorMessage(name: string): string {
  const known = knownToolNames();
  const mapped = fromWireName(name);
  const hint =
    mapped && mapped !== name && known.includes(mapped)
      ? ` Did you mean ${mapped}?`
      : "";
  return `Unknown tool: ${name}.${hint} Tool names are dotted namespace.action pairs (task.update, not task_update). Available tools: ${known.join(", ")}`;
}

/**
 * Keys that mean "this is a file/content payload, not a command line". When a
 * hallucinated call carries one of these, we refuse to synthesize shell text
 * from it: concatenating file content into a command line is how metacharacters
 * in model output become executed shell.
 */
const CONTENT_SHAPED_ARG_KEYS = new Set([
  "content",
  "contents",
  "body",
  "text",
  "data",
  "file_text",
  "filetext",
  "new_str",
  "newstr",
  "old_str",
  "oldstr",
  "patch",
  "diff",
  "source",
  "stdin",
  "input",
]);

/** Explicit command-bearing fields, in precedence order. */
const COMMAND_ARG_KEYS = [
  "command",
  "cmd",
  "commandLine",
  "command_line",
  "argv",
  "args",
  "arguments",
] as const;

const SHELL_SAFE_TOKEN_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuoteToken(token: string): string {
  if (SHELL_SAFE_TOKEN_RE.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a shell command string from a bare-command tool call. Models often
 * emit the binary as the tool name (`sed`, `awk`, `git`, …) and put the rest
 * into an explicit `command`/`cmd`/`argv`/`args` field. Only those explicit
 * fields are honored: array forms are shell-quoted per element, and calls that
 * look like a file-write shape (content/body/text/patch/...) are rejected so
 * an unknown-tool error is surfaced instead of executing model text.
 */
function buildShellCommandFromCall(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  const trimmedName = name.trim();
  const keys = Object.keys(args);
  for (const key of keys) {
    if (CONTENT_SHAPED_ARG_KEYS.has(key.toLowerCase())) return undefined;
  }

  const asText = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) {
      const parts = value
        .filter((v) => typeof v === "string" || typeof v === "number")
        .map((v) => shellQuoteToken(String(v)));
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    return undefined;
  };

  let rest: string | undefined;
  for (const key of COMMAND_ARG_KEYS) {
    const text = asText(args[key]);
    if (text !== undefined) {
      rest = text;
      break;
    }
  }

  if (rest === undefined) {
    // No explicit command field. A name-only call with no other arguments is
    // still runnable (`whoami`); anything else is an unknown tool, not a
    // command to be assembled out of arbitrary model values.
    const meaningful = keys.filter(
      (key) => !["cwd", "timeoutMs", "iOwnThis", "own"].includes(key),
    );
    if (meaningful.length > 0) return undefined;
    return trimmedName || undefined;
  }

  const trimmedRest = rest.trim();
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
const CLASSIC_TOOL_ALIASES: Record<string, string> = {
  bash: "shell.exec",
  read: "fs.read",
  write: "fs.write",
  edit: "fs.edit",
  multiedit: "fs.edit",
  ls: "fs.list",
  glob: "fs.list",
  grep: "fs.search",
  webfetch: "web.fetch",
  websearch: "web.search",
};

function remapClassicArgs(call: ToolCall): ToolCall {
  const args = { ...(call.args ?? {}) };
  if (typeof args.file_path === "string" && args.path === undefined) {
    args.path = args.file_path;
    delete args.file_path;
  }
  if (typeof args.old_string === "string" && args.oldText === undefined) {
    args.oldText = args.old_string;
    delete args.old_string;
  }
  if (typeof args.new_string === "string" && args.newText === undefined) {
    args.newText = args.new_string;
    delete args.new_string;
  }
  return { name: call.name, args };
}

const GATEWAY_ARG_ENVELOPES = new Set(["input", "arguments", "parameters"]);

function unwrapGatewayToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(args);
  if (keys.length !== 1 || !GATEWAY_ARG_ENVELOPES.has(keys[0]!)) return args;
  const value = args[keys[0]!];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return args;
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : args;
  } catch {
    return args;
  }
}

export function normalizeToolCall(call: ToolCall): ToolCall {
  let name = typeof call.name === "string" ? call.name.trim() : "";
  const originalArgs = call.args ?? {};
  const classic = CLASSIC_TOOL_ALIASES[name.toLowerCase()];
  if (classic && !toolRegistry[name]) {
    const args = unwrapGatewayToolArgs(originalArgs);
    const hasShellShape = COMMAND_ARG_KEYS.some((key) => args[key] !== undefined);
    if (classic === "shell.exec" || !hasShellShape) {
      return remapClassicArgs({ name: classic, args });
    }
  }
  if (name && !toolRegistry[name]) {
    const cleaned = sanitizeToolName(name);
    const mapped = fromWireName(cleaned) ?? fromWireName(name) ?? cleaned;
    if (
      mapped &&
      (toolRegistry[mapped] ||
        NON_REGISTRY_TOOL_NAMES.has(mapped) ||
        mapped.startsWith("mcp."))
    ) {
      return { name: mapped, args: unwrapGatewayToolArgs(originalArgs) };
    }
    if (cleaned && cleaned !== name) name = cleaned;
  }
  if (toolRegistry[name]) {
    const args = unwrapGatewayToolArgs(originalArgs);
    return name === call.name && args === originalArgs ? call : { name, args };
  }
  if (!name || name.includes(".") || name.includes("/")) {
    return name === call.name ? call : { name, args: originalArgs };
  }
  const command = buildShellCommandFromCall(name, originalArgs);
  if (!command) return call;
  const shellArgs: Record<string, unknown> = { command };
  if (typeof originalArgs.cwd === "string") shellArgs.cwd = originalArgs.cwd;
  if (typeof originalArgs.timeoutMs === "number") {
    shellArgs.timeoutMs = originalArgs.timeoutMs;
  }
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

export function normalizeToolResult(
  name: string,
  result: ToolResult,
): ToolResult {
  if (result.output.trim()) return result;
  const exit = result.exitCode === undefined ? "" : ` (exit=${result.exitCode})`;
  return {
    ...result,
    output: result.ok
      ? `Tool ${name} completed successfully${exit}, but produced no textual output.`
      : `Tool ${name} failed${exit} without textual output.`,
  };
}

export async function runToolCall(
  call: ToolCall,
  options: ToolRunOptions = {},
): Promise<ToolResult> {
  const normalized = normalizeToolCall(call);
  const handler = toolRegistry[normalized.name];
  if (!handler) {
    throw new Error(unknownToolErrorMessage(normalized.name));
  }
  const elidedStub = findElidedStubArg(normalized.args);
  if (elidedStub) {
    return {
      ok: false,
      exitCode: 1,
      output: elidedStubReuseMessage(elidedStub.key),
    };
  }
  return normalizeToolResult(
    normalized.name,
    await handler(normalized.args, options),
  );
}

/**
 * Tools that may run **in parallel** inside `tool.batch` without racing
 * mutates. Anything outside this set is still allowed in a batch but is
 * forced serial (and may require confirmation — see {@link runToolBatch}).
 *
 * Kept for tests and call-sites that want the parallel-safe set.
 */
export const BATCH_SAFE_TOOLS = new Set([
  "fs.read",
  "fs.list",
  "fs.search",
  "http.fetch",
  "sysinfo",
  "dns.lookup",
  "whois.lookup",
  "net.context",
  "net.scan",
  "net.pingSweep",
  "pentest.recon",
  "tool.check",
  "wordlist.find",
  "image.ocr",
  "image.view",
  "pdf.read",
  "web.search",
  "web.fetch",
  "shell.jobs",
  "shell.tail",
  "skill.list",
  "skill.load",
]);

/**
 * Tools that must never ride inside tool.batch (session bookkeeping /
 * recursive batch / mode handoff). Everything else registered is allowed.
 */
const BATCH_FORBIDDEN_TOOLS = new Set([
  "tool.batch",
  ...INTERACTIVE_SESSION_TOOL_NAMES,
  "plan.create",
  "task.move",
  "task.read",
  "task.update",
  "agent.handoff",
  "instructions.record",
]);

const BATCH_MAX_CALLS = 20;
const BATCH_DEFAULT_CONCURRENCY = 3;
const BATCH_MAX_CONCURRENCY = 6;
/** Default batch ceiling; the model may override it with timeoutMs. */
const BATCH_HARD_TIMEOUT_MS = 40_000;
/** Progress heartbeats keep the outer tool stall watchdog alive. */
const BATCH_HEARTBEAT_MS = 5_000;

interface BatchCallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
  cancelOnFail: string[];
  index0: number;
}

/**
 * Normalize a batch child tool name: wire forms (`tool_check`, `fs_read`)
 * and dotted names both resolve to the registry canonical name.
 */
export function normalizeBatchToolName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (toolRegistry[trimmed] || NON_REGISTRY_TOOL_NAMES.has(trimmed)) return trimmed;
  const mapped = fromWireName(trimmed);
  if (mapped && (toolRegistry[mapped] || NON_REGISTRY_TOOL_NAMES.has(mapped))) return mapped;
  // Underscore-all form that fromWireName may still leave as-is if unregistered
  // mid-name (tool_check → tool.check via first underscore heuristic).
  if (!trimmed.includes(".") && trimmed.includes("_")) {
    const dotted = trimmed.replace(/_/g, ".");
    if (toolRegistry[dotted] || NON_REGISTRY_TOOL_NAMES.has(dotted)) return dotted;
  }
  return trimmed;
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
  const seenIds = new Set<string>();
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
    const rec = entry as Record<string, unknown>;
    const rawName = rec.name as string;
    const args = rec.args as Record<string, unknown>;
    const name = normalizeBatchToolName(rawName);
    if (BATCH_FORBIDDEN_TOOLS.has(name)) {
      throw new Error(
        `tool.batch refuses to run "${rawName}" — ${name} cannot be nested inside a batch`,
      );
    }
    if (!toolRegistry[name]) {
      throw new Error(
        `tool.batch refuses unknown tool "${rawName}"` +
          (name !== rawName ? ` (normalized to "${name}")` : "") +
          `. Available tools: ${knownToolNames().join(", ")}`,
      );
    }
    const id = resolveBatchCallId(rec, index, seenIds);
    const cancelOnFail = parseCancelOnFailField(rec, `call #${index}`);
    return { id, name, args, cancelOnFail, index0: index };
  });
}

/** Combine parent abort + policy abort into one signal for children. */
function mergeAbortSignals(
  a: AbortSignal,
  b: AbortSignal,
): AbortSignal {
  const anyFn = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anyFn === "function") {
    return anyFn([a, b]);
  }
  const ac = new AbortController();
  const forward = (): void => {
    if (!ac.signal.aborted) ac.abort();
  };
  if (a.aborted || b.aborted) {
    ac.abort();
    return ac.signal;
  }
  a.addEventListener("abort", forward, { once: true });
  b.addEventListener("abort", forward, { once: true });
  return ac.signal;
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

type BatchOutcomeStatus = "ok" | "fail" | "cancelled";

interface BatchOutcome {
  index: number;
  id: string;
  name: string;
  status: BatchOutcomeStatus;
  ok: boolean;
  output: string;
  exitCode?: number | undefined;
  error?: string | undefined;
  suppressedRepeat?: boolean | undefined;
  /**
   * Images a child wants the model to look at (image.view). Without this the
   * aggregate result would drop the bytes while still telling the model an
   * image was attached.
   */
  images?: ChatImage[] | undefined;
}

async function runToolBatch(
  args: Record<string, unknown>,
  options?: ToolRunOptions,
): Promise<ToolResult> {
  const calls = parseBatchCalls(args.calls);
  const knownIds = new Set(calls.map((c) => c.id));
  const callMeta: BatchCallFailMeta[] = calls.map((c) => ({
    id: c.id,
    name: c.name,
    index1: c.index0 + 1,
    cancelOnFail: c.cancelOnFail,
  }));
  const metaById = new Map(callMeta.map((m) => [m.id, m]));
  const failMode: BatchFailMode = compileBatchFailMode(
    parseBatchFailPolicy(args, knownIds),
    callMeta,
    knownIds,
  );

  // Re-classify each child: block always refused; confirm allowed only when
  // the parent turn already confirmed (options.confirmed) so shell/fs mutates
  // cannot sneak past the safety gate as a "safe" batch wrapper.
  const scope = await loadScopeForSession(options?.sessionId).catch(
    () => undefined,
  );
  let needsSerial = false;
  for (const spec of calls) {
    const decision = classifyToolCall(
      { name: spec.name, args: spec.args },
      { scope },
    );
    if (decision.level === "block") {
      throw new Error(
        `tool.batch refuses ${spec.name}: ${decision.reason}`,
      );
    }
    if (decision.level === "confirm") {
      if (!options?.confirmed) {
        throw new Error(
          `tool.batch refuses ${spec.name}: ${decision.reason} ` +
            `(confirm-level tools need approval — emit them as top-level tools, or re-run the batch after confirm)`,
        );
      }
      needsSerial = true;
    }
    // Non-parallel-safe tools always serialize to avoid racing writes/shells.
    if (!BATCH_SAFE_TOOLS.has(spec.name)) {
      needsSerial = true;
    }
  }
  const requestedConcurrency = Math.max(
    1,
    Math.min(
      typeof args.concurrency === "number"
        ? Math.floor(args.concurrency)
        : BATCH_DEFAULT_CONCURRENCY,
      BATCH_MAX_CONCURRENCY,
    ),
  );
  // Parallel only when every child is read-only/safe-parallel. Mixed or
  // mutating batches run one-at-a-time in order.
  // Selective/fail-fast policies also force serial so cancel decisions apply
  // before dependents start (deterministic for models).
  if (failMode.kind !== "continue") {
    needsSerial = true;
  }
  const concurrency = needsSerial ? 1 : requestedConcurrency;

  // Local abort that fires on parent cancel OR the batch hard timeout.
  // Children receive this signal so a hung http.fetch/dns cannot pin the UI
  // on "● tool.batch running" forever.
  const batchAc = new AbortController();
  // Policy cancel (on_fail) — separate from user Esc / hard timeout.
  const policyAc = new AbortController();
  const onParentAbort = (): void => {
    if (!batchAc.signal.aborted) batchAc.abort();
  };
  if (options?.signal) {
    if (options.signal.aborted) batchAc.abort();
    else options.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const batchTimeoutMs = Math.max(
    1_000,
    Math.min(
      1_800_000,
      optionalNumber(args, "timeoutMs") ?? BATCH_HARD_TIMEOUT_MS,
    ),
  );
  const hardTimer = setTimeout(() => {
    if (!batchAc.signal.aborted) batchAc.abort();
  }, batchTimeoutMs);
  (hardTimer as unknown as { unref?: () => void }).unref?.();

  let finished = 0;
  const failedIds = new Set<string>();
  const cancelledIds = new Set<string>();
  /** id → human reason for policy cancel */
  const cancelReasons = new Map<string, string>();
  let policyCancelCount = 0;

  const tick = (line: string): void => {
    // Heartbeats also reset the runner's 60s "stalled tool" watchdog, which
    // previously aborted silent batches mid-flight and left no tool-result.
    options?.onOutput?.(line.endsWith("\n") ? line : `${line}\n`, "stdout");
  };
  /** Stream a finished child as a nested `── #N` section so the live UI can
   * expand sub-cards with real output (not just "ok" status ticks). */
  const streamSection = (outcome: BatchOutcome): void => {
    const status = outcome.status;
    const head = `── #${outcome.index + 1} ${outcome.name} [${status}${
      outcome.exitCode !== undefined ? ` exit=${outcome.exitCode}` : ""
    }]`;
    const body = outcome.error
      ? `error: ${outcome.error}`
      : (outcome.output ?? "").trim();
    tick(body ? `${head}\n${body}\n\n` : `${head}\n\n`);
  };
  const modeLabel =
    failMode.kind === "continue"
      ? "continue"
      : failMode.kind === "cancel_pending"
        ? "cancel_pending"
        : `rules(${failMode.rules.length})`;
  tick(
    `[batch] starting ${calls.length} call(s), concurrency=${concurrency}, on_fail=${modeLabel}`,
  );
  const heartbeat = setInterval(() => {
    tick(`[batch] still running — ${finished}/${calls.length} finished`);
  }, BATCH_HEARTBEAT_MS);
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  const applyFailPolicy = (justFailedId: string): void => {
    failedIds.add(justFailedId);
    const targets = evaluateCancelTargets(
      failMode,
      failedIds,
      calls.map((c) => c.id),
    );
    if (targets.size === 0) return;
    const triggerList = [...failedIds];
    const reason = formatBatchCancelReason(triggerList, metaById);
    let newly = 0;
    for (const id of targets) {
      if (cancelledIds.has(id)) continue;
      // Never mark the just-failed id as cancelled (it has a real outcome).
      if (failedIds.has(id)) continue;
      const idx = calls.findIndex((c) => c.id === id);
      if (idx < 0) continue;
      // Already finished with a result — leave it.
      if (outcomes[idx]) continue;
      cancelledIds.add(id);
      cancelReasons.set(id, reason);
      newly += 1;
    }
    if (newly > 0) {
      policyCancelCount += newly;
      if (!policyAc.signal.aborted) policyAc.abort();
      tick(
        `[batch] on_fail cancelled ${newly} call(s) after ${metaById.get(justFailedId)?.name ?? justFailedId} failed`,
      );
    }
  };

  const outcomes: Array<BatchOutcome | undefined> = new Array(calls.length);
  const childSignal = mergeAbortSignals(batchAc.signal, policyAc.signal);

  try {
    await runWithLimit(calls, concurrency, async (spec, index) => {
      // Policy-cancelled before start (or mid-batch after sibling fail).
      if (cancelledIds.has(spec.id) && !outcomes[index]) {
        outcomes[index] = {
          index,
          id: spec.id,
          name: spec.name,
          status: "cancelled",
          ok: false,
          output:
            cancelReasons.get(spec.id) ??
            "Cancelled — not run because a sibling call failed",
          exitCode: 130,
        };
        finished += 1;
        tick(`[batch] #${index + 1} ${spec.name} cancelled`);
        streamSection(outcomes[index]!);
        return;
      }

      if (batchAc.signal.aborted) {
        outcomes[index] = {
          index,
          id: spec.id,
          name: spec.name,
          status: "cancelled",
          ok: false,
          output: "Aborted before execution.",
          exitCode: 130,
        };
        finished += 1;
        streamSection(outcomes[index]!);
        return;
      }

      // Re-check cancel after waiting in the worker queue.
      if (cancelledIds.has(spec.id)) {
        outcomes[index] = {
          index,
          id: spec.id,
          name: spec.name,
          status: "cancelled",
          ok: false,
          output:
            cancelReasons.get(spec.id) ??
            "Cancelled — not run because a sibling call failed",
          exitCode: 130,
        };
        finished += 1;
        tick(`[batch] #${index + 1} ${spec.name} cancelled`);
        streamSection(outcomes[index]!);
        return;
      }

      tick(`[batch] #${index + 1} ${spec.name} starting`);
      try {
        // Lightweight child heartbeats so silent tools (whois) never trip the
        // outer 60s stall watchdog while still running under the batch.
        const childHeartbeat = setInterval(() => {
          tick(`[batch] #${index + 1} ${spec.name} still running…`);
        }, BATCH_HEARTBEAT_MS);
        (childHeartbeat as unknown as { unref?: () => void }).unref?.();
        let result: ToolResult;
        try {
          result = await runToolCall(
            { name: spec.name, args: spec.args },
            // Do not fan full child stdout into the parent spool (parallel
            // interleaving). Settled section bodies are streamed below so the
            // live UI can show expanded nested cards immediately.
            // Forward confirmed so approved mutates inside a batch still run.
            {
              signal: childSignal,
              ...(options?.confirmed !== undefined
                ? { confirmed: options.confirmed }
                : {}),
              ...(options?.requestSecret
                ? { requestSecret: options.requestSecret }
                : {}),
              ...(options?.authorizeNetworkHop
                ? { authorizeNetworkHop: options.authorizeNetworkHop }
                : {}),
              ...(options?.engagementAuthorization
                ? { engagementAuthorization: options.engagementAuthorization }
                : {}),
              ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
              ...(options?.llmProvider ? { llmProvider: options.llmProvider } : {}),
              ...(options?.llmModel ? { llmModel: options.llmModel } : {}),
              ...(options?.taskId ? { taskId: options.taskId } : {}),
              ...(options?.parentTaskId ? { parentTaskId: options.parentTaskId } : {}),
              ...(options?.delegationId ? { delegationId: options.delegationId } : {}),
              ...(options?.wakeOnCompletion !== undefined
                ? { wakeOnCompletion: options.wakeOnCompletion }
                : {}),
              ...(options?.monitor !== undefined ? { monitor: options.monitor } : {}),
            },
          );
        } finally {
          clearInterval(childHeartbeat);
        }

        // If we were policy-aborted mid-flight and the child looks aborted,
        // surface as cancelled rather than a generic fail when we intended cancel.
        if (
          cancelledIds.has(spec.id) ||
          (policyAc.signal.aborted &&
            !result.ok &&
            (result.exitCode === 130 ||
              /abort|cancel/i.test(result.output ?? "")))
        ) {
          const reason =
            cancelReasons.get(spec.id) ??
            "Cancelled — aborted because a sibling call failed";
          outcomes[index] = {
            index,
            id: spec.id,
            name: spec.name,
            status: "cancelled",
            ok: false,
            output: reason,
            exitCode: 130,
          };
          cancelledIds.add(spec.id);
          tick(`[batch] #${index + 1} ${spec.name} cancelled`);
          streamSection(outcomes[index]!);
        } else if (result.ok) {
          outcomes[index] = {
            index,
            id: spec.id,
            name: spec.name,
            status: "ok",
            ok: true,
            output: result.output,
            exitCode: result.exitCode,
            ...(result.suppressedRepeat ? { suppressedRepeat: true } : {}),
            ...(result.images?.length ? { images: result.images } : {}),
          };
          tick(
            `[batch] #${index + 1} ${spec.name} ok` +
              (result.exitCode !== undefined
                ? ` exit=${result.exitCode}`
                : ""),
          );
          streamSection(outcomes[index]!);
        } else {
          outcomes[index] = {
            index,
            id: spec.id,
            name: spec.name,
            status: "fail",
            ok: false,
            output: result.output,
            exitCode: result.exitCode,
            ...(result.suppressedRepeat ? { suppressedRepeat: true } : {}),
          };
          tick(
            `[batch] #${index + 1} ${spec.name} fail` +
              (result.exitCode !== undefined
                ? ` exit=${result.exitCode}`
                : ""),
          );
          streamSection(outcomes[index]!);
          applyFailPolicy(spec.id);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        // Policy abort while starting/running → cancelled if we marked it.
        if (cancelledIds.has(spec.id) || policyAc.signal.aborted) {
          outcomes[index] = {
            index,
            id: spec.id,
            name: spec.name,
            status: "cancelled",
            ok: false,
            output:
              cancelReasons.get(spec.id) ??
              "Cancelled — aborted because a sibling call failed",
            exitCode: 130,
          };
          cancelledIds.add(spec.id);
          tick(`[batch] #${index + 1} ${spec.name} cancelled`);
          streamSection(outcomes[index]!);
        } else {
          outcomes[index] = {
            index,
            id: spec.id,
            name: spec.name,
            status: "fail",
            ok: false,
            output: "",
            error: message,
          };
          tick(`[batch] #${index + 1} ${spec.name} error: ${message}`);
          streamSection(outcomes[index]!);
          applyFailPolicy(spec.id);
        }
      } finally {
        finished += 1;
      }
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(hardTimer);
    if (options?.signal) {
      options.signal.removeEventListener("abort", onParentAbort);
    }
  }

  // Fill any holes left by a mid-batch abort/timeout/policy cancel so we
  // always emit a complete sectioned body and a tool-result.
  const parentAborted = Boolean(options?.signal?.aborted);
  // Hard timeout aborts batchAc; policy cancel only aborts policyAc.
  const hardTimedOut = batchAc.signal.aborted && !parentAborted;

  for (let i = 0; i < calls.length; i += 1) {
    if (outcomes[i]) continue;
    const spec = calls[i]!;
    if (cancelledIds.has(spec.id) || cancelReasons.has(spec.id)) {
      outcomes[i] = {
        index: i,
        id: spec.id,
        name: spec.name,
        status: "cancelled",
        ok: false,
        output:
          cancelReasons.get(spec.id) ??
          "Cancelled — not run because a sibling call failed",
        exitCode: 130,
      };
      continue;
    }
    if (parentAborted) {
      outcomes[i] = {
        index: i,
        id: spec.id,
        name: spec.name,
        status: "cancelled",
        ok: false,
        output: "Not run — batch aborted.",
        exitCode: 130,
      };
      continue;
    }
    if (hardTimedOut) {
      outcomes[i] = {
        index: i,
        id: spec.id,
        name: spec.name,
        status: "fail",
        ok: false,
        output: `Not run — tool.batch timed out after ${Math.round(batchTimeoutMs / 1000)}s.`,
        exitCode: 124,
      };
      continue;
    }
    outcomes[i] = {
      index: i,
      id: spec.id,
      name: spec.name,
      status: "cancelled",
      ok: false,
      output: "Not run — batch aborted.",
      exitCode: 130,
    };
  }

  const finalOutcomes = outcomes as BatchOutcome[];
  const allOk = finalOutcomes.every((outcome) => outcome.ok);
  const sections = finalOutcomes.map((outcome) => {
    const status = outcome.status;
    const head = `── #${outcome.index + 1} ${outcome.name} [${status}${outcome.exitCode !== undefined ? ` exit=${outcome.exitCode}` : ""}]`;
    const body = outcome.error
      ? `error: ${outcome.error}`
      : outcome.output.trim();
    return `${head}\n${body}`;
  });
  let output = sections.join("\n\n");
  if (hardTimedOut && !allOk) {
    output =
      `[batch] timed out after ${Math.round(batchTimeoutMs / 1000)}s — partial results below\n\n` +
      output;
  } else if (policyCancelCount > 0) {
    const n = finalOutcomes.filter((o) => o.status === "cancelled").length;
    if (n > 0) {
      output =
        `[batch] on_fail cancelled ${n} call(s) — partial results below\n\n` +
        output;
    }
  }
  // `ok` is the signal the runner, loop-guard, and task-evidence layers use, so
  // it reports the truth: a batch whose children failed is NOT a success. The
  // original intent (a failed child must not cancel sibling top-level tools) is
  // preserved by `partial`, which tells the runner this was a partial result
  // rather than an aborted or hard-failed call.
  const anyOk = finalOutcomes.some((outcome) => outcome.ok);
  const allSuppressed =
    finalOutcomes.length > 0 &&
    finalOutcomes.every((outcome) => outcome.suppressedRepeat);
  // Children run in index order in the sectioned body, so keep the same order
  // here: the model is told "attached in this order" and must be able to match
  // each image back to the section that requested it.
  const batchImages = finalOutcomes.flatMap((outcome) => outcome.images ?? []);
  return {
    ok: allOk,
    partial: !allOk && anyOk && !parentAborted && !hardTimedOut,
    output,
    exitCode: allOk ? 0 : hardTimedOut ? 124 : parentAborted ? 130 : 1,
    ...(allSuppressed ? { suppressedRepeat: true } : {}),
    ...(batchImages.length ? { images: batchImages } : {}),
  };
}
