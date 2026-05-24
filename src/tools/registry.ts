import { detectSystem } from "../os/detect.js";
import { detectPackageManager, assertSafePackageName } from "../os/pkgmgr.js";
import type { ToolCall, ToolResult } from "../types.js";
import { fsList, fsRead, fsSearch, fsWrite } from "./fs.js";
import { httpFetch } from "./http.js";
import { shellExec, spawnArgv } from "./shell.js";
import { classifyToolCall } from "../safety/classifier.js";
import { loadScope } from "../store/scope.js";
import {
  parseHost,
  parsePortSpec,
  parseLegacyFlags,
  profileToNmapArgs,
  type ScanProfile,
} from "./validate.js";

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

export const toolRegistry: Record<string, ToolHandler> = {
  async "shell.exec"(args, options) {
    return shellExec({
      command: requireString(args, "command"),
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
  async "fs.list"(args) {
    return fsList(optionalString(args, "path") ?? process.cwd(), {
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
    const profileArgs = profileToNmapArgs(profile);
    const legacyArgs = legacyFlags ? parseLegacyFlags(legacyFlags) : [];
    const argv: string[] = [];
    if (ports) argv.push("-p", ports);
    argv.push(...profileArgs, ...legacyArgs, host.value);
    return spawnArgv({
      command: "nmap",
      argv,
      timeoutMs: 300_000,
      signal: options?.signal,
      onOutput: options?.onOutput,
    });
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
      "A", "AAAA", "ANY", "CAA", "CNAME", "MX", "NS", "PTR", "SOA", "SRV", "TXT",
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
    const allSteps: Array<{ key: "whois" | "dns" | "nmap"; command: string; argv: string[] }> = [
      { key: "whois", command: "whois", argv: [host.value] },
      { key: "dns", command: "dig", argv: [host.value, "ANY", "+noall", "+answer"] },
      { key: "nmap", command: "nmap", argv: ["-sV", "--top-ports", "100", host.value] },
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
      const result = await spawnArgv({
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
};

export function availableToolNames(): string[] {
  return Object.keys(toolRegistry);
}

export async function runToolCall(
  call: ToolCall,
  options: ToolRunOptions = {},
): Promise<ToolResult> {
  const handler = toolRegistry[call.name];
  if (!handler) {
    throw new Error(`Unknown tool: ${call.name}`);
  }
  return handler(call.args, options);
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
