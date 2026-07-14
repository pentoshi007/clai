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
  fsReplaceLines,
  fsAppend,
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
  type ScanProfile,
} from "./validate.js";
import { getNetworkContext } from "./network-context.js";
import { pingSweep } from "./net-ping-sweep.js";
import { toolCheckHandler } from "./capabilities.js";
import { wordlistFind } from "./wordlists.js";
import { jobManager } from "./jobs.js";
import { looksLongRunning } from "./command-intent.js";
import { packageBinaryName } from "./package-binary.js";
import { runNmapScan } from "./nmap-runner.js";
import { type ToolRunOptions, type ToolHandler } from "./tool-types.js";

export type { ToolRunOptions, ToolHandler };

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
  async "fs.read"(args, options) {
    return fsRead(requireString(args, "path"), {
      maxBytes: optionalNumber(args, "maxBytes"),
      offset: optionalNumber(args, "offset"),
      limit: optionalNumber(args, "limit"),
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
      { confirmed: options?.confirmed },
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
    let profile =
      args.profile &&
      typeof args.profile === "object" &&
      !Array.isArray(args.profile)
        ? (args.profile as ScanProfile)
        : undefined;

    const userPrompt = options?.userPrompt;
    const isConnectRequested = Boolean(
      userPrompt &&
      /\b(?:-sT|connect scan|tcp connect|normal scan|unprivileged scan)\b/i.test(userPrompt)
    );

    if (profile && profile.scanType === "tcp" && !isConnectRequested) {
      profile = { ...profile, scanType: "syn" };
    }

    const legacyFlags = optionalString(args, "flags");
    // ports and topPorts conflict on the nmap CLI — ports takes priority
    const cleanedProfile =
      ports && profile?.topPorts
        ? { ...profile, topPorts: undefined }
        : profile;
    const profileArgs = profileToNmapArgs(cleanedProfile);
    let legacyArgs = legacyFlags ? parseLegacyFlags(legacyFlags) : [];
    if (!isConnectRequested) {
      legacyArgs = legacyArgs.map(arg => arg === "-sT" ? "-sS" : arg);
    }
    const argv: string[] = [];
    if (ports) argv.push("-p", ports);
    argv.push(...profileArgs, ...legacyArgs, host.value);
    return runNmapScan(argv, options);
  },
  async "http.fetch"(args, options) {
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
      retries: optionalNumber(args, "retries"),
      signal: options?.signal,
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
    fetchArgs.includeHeaders = includeHeaders ?? false;
    const includeTls = optionalBoolean(args, "includeTls");
    fetchArgs.includeTls = includeTls ?? false;
    const includeTiming = optionalBoolean(args, "includeTiming");
    fetchArgs.includeTiming = includeTiming ?? false;
    const includeRedirectChain = optionalBoolean(args, "includeRedirectChain");
    fetchArgs.includeRedirectChain = includeRedirectChain ?? false;
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
    const { getArtifactDir } = await import("../store/paths.js");
    const artifactDir = getArtifactDir();
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
    return fsReplaceLines(
      requireString(args, "path"),
      requireNumber(args, "startLine"),
      requireNumber(args, "endLine"),
      requireString(args, "content"),
      { confirmed: options?.confirmed },
    );
  },
  async "fs.append"(args, options) {
    return fsAppend(
      requireString(args, "path"),
      requireString(args, "content"),
      {
        position: optionalString(args, "position") as "start" | "end" | undefined,
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
export const BATCH_SAFE_TOOLS = new Set([
  "fs.read",
  "fs.list",
  "fs.search",
  "http.fetch",
  "sysinfo",
  "dns.lookup",
  "whois.lookup",
  "net.context",
  "tool.check",
  "wordlist.find",
  "image.ocr",
  "pdf.read",
  "web.search",
  "web.fetch",
]);

const BATCH_MAX_CALLS = 20;
const BATCH_DEFAULT_CONCURRENCY = 3;
const BATCH_MAX_CONCURRENCY = 6;

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
