import type { ToolDefinition } from "../types.js";
import {
  registerWireNamesFor,
  toSnakeWireName,
  toWireName,
} from "../llm/tool-protocol.js";

/**
 * Tools whose handler actually honors `timeoutMs`. The property used to be
 * injected into every schema, which cost ~45 tokens per tool on every request
 * and told the model it could bound operations (fs.read, pdf.read, plan.*) that
 * silently ignored it.
 */
const TIMED_TOOLS = new Set([
  "shell.exec",
  "http.fetch",
  "web.fetch",
  "web.search",
  "net.scan",
  "net.pingSweep",
  "pentest.recon",
  "pentest.webDiscover",
  "pentest.apiEnumerate",
  "pentest.authCompare",
  "pentest.scanStatus",
  "pkg.install",
  "tool.batch",
  "tool.check",
  "image.ocr",
  "pdf.read",
  "dns.lookup",
  "whois.lookup",
  "fs.search",
]);

function def(
  name: string,
  description: string,
  parameters: ToolDefinition["parameters"],
  flags: Partial<Pick<ToolDefinition, "readOnly" | "mutates" | "askMode">> = {},
): ToolDefinition {
  const timedParameters: ToolDefinition["parameters"] = !TIMED_TOOLS.has(name)
    ? parameters
    : {
          ...parameters,
          properties: {
            ...(parameters.properties ?? {}),
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: 1_800_000,
              description:
                "Wall-clock timeout in milliseconds (default 40000). You can decide how much time is enough for this task and set timeoutMs accordingly — choose a larger value when the operation is expected to take longer.",
              ...((parameters.properties?.timeoutMs as
                | Record<string, unknown>
                | undefined) ?? {}),
            },
          },
        };
  // Primary wire keeps camelCase (fs_writeMany); also register snake alias.
  const wireName = registerWireNamesFor(name);
  return {
    name,
    wireName,
    description,
    parameters: timedParameters,
    ...flags,
  };
}

const emptyObject = {
  type: "object" as const,
  properties: {} as Record<string, unknown>,
  additionalProperties: false,
};

/** Plan tools dispatched specially in the runner (not in toolRegistry). */
export const PLAN_TOOL_NAMES = new Set([
  "plan.clear",
  "plan.create",
  "task.add",
  "task.move",
  "task.read",
  "task.update",
]);

/** Plan-independent Responder receipt tools dispatched by the runner. */
export const RESPONDER_TOOL_NAMES = new Set(["job.read"]);

/** Every runner-owned meta tool that has no registry handler. */
export const RUNNER_META_TOOL_NAMES = new Set([
  ...PLAN_TOOL_NAMES,
  ...RESPONDER_TOOL_NAMES,
]);

/** Meta tools with no registry handler (runner-owned + ask-mode handoff). */
export const NON_REGISTRY_TOOL_NAMES = new Set([
  ...RUNNER_META_TOOL_NAMES,
  "agent.handoff",
  "loop.reset",
]);

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  def(
    "fs.read",
    [
      "Read a text file (or list a directory if path is a dir).",
      "Decision guide:",
      "(1) Small/unknown path → fs.read {path} only; small files return fully.",
      "(2) If output has auto-head or hasMore=true → you do NOT have the whole file; continue with the exact next offset/limit from the footer (do not re-call path-only).",
      "(3) Known line range → offset+limit or startLine+endLine (1-indexed inclusive).",
      "(4) Looking for a symbol/string → pattern (regex or /pattern/i) with optional context, OR fs.search then fs.read around hit lines.",
      "(5) Prefer partial/pattern reads for large files — saves tokens and avoids re-reads.",
      "Lines in the body are numbered as N: text. Headers report path/range/matches/hasMore.",
    ].join(" "),
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (absolute, relative, or ~)",
        },
        offset: {
          type: "integer",
          description:
            "1-indexed start line for paging (alias: startLine). 0 is accepted and treated as 1.",
        },
        limit: {
          type: "integer",
          description: "Max lines to return from offset (default 200 when paging)",
        },
        startLine: {
          type: "integer",
          description: "1-indexed inclusive start line (alias of offset)",
        },
        endLine: {
          type: "integer",
          description: "1-indexed inclusive end line",
        },
        pattern: {
          type: "string",
          description:
            'Match windows: JS regex source ("function\\\\s+foo") or /pattern/flags. Use for symbols/strings instead of loading the whole file.',
        },
        context: {
          type: "integer",
          description: "Lines of context around each pattern match (default 2)",
        },
        maxMatches: {
          type: "integer",
          description: "Max pattern matches (default 20, max 100)",
        },
        caseInsensitive: {
          type: "boolean",
          description: "Case-insensitive pattern match (or use /pattern/i)",
        },
        maxBytes: {
          type: "integer",
          description: "Hard max bytes for full reads of small/medium files",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "fs.write",
    "Create a new file or fully overwrite one with complete content. For an existing file already read, prefer fs.edit/replaceLines; if a full rewrite is necessary, preserve the complete file and inspect the returned diff before continuing.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: {
          type: "string",
          description: "Full file contents in one call",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.writeMany",
    "Write multiple complete files in one call (scaffold). Max 50 files.",
    {
      type: "object",
      properties: {
        files: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.list",
    "List directory entries.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        maxEntries: { type: "integer" },
      },
      required: [],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "fs.search",
    "Search file contents by pattern (ripgrep-style). Returns path:line:text hits so you can follow up with fs.read offset/limit or pattern.",
    {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        maxMatches: {
          type: "integer",
          description: "Max hit lines (default 50)",
        },
        maxPerFile: {
          type: "integer",
          description: "Max hits per file (default 20)",
        },
        glob: {
          type: "string",
          description:
            "Restrict to matching paths, ripgrep -g syntax (e.g. \"*.ts\", \"src/**/*.tsx\").",
        },
        caseInsensitive: { type: "boolean" },
        fixedString: {
          type: "boolean",
          description: "Treat pattern as a literal string instead of a regex.",
        },
        context: {
          type: "integer",
          minimum: 0,
          maximum: 10,
          description: "Lines of context around each hit.",
        },
        filesOnly: {
          type: "boolean",
          description: "Return matching file paths only.",
        },
        hidden: {
          type: "boolean",
          description: "Include hidden files and directories.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "fs.edit",
    "Surgical in-place edit: replace exact oldText with newText.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        expectedReplacements: { type: "integer" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.replaceLines",
    "Replace a 1-indexed inclusive line range after reading the file. Empty content (or delete:true) deletes that range.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer" },
        endLine: { type: "integer" },
        content: {
          type: "string",
          description:
            "Replacement text. Empty string deletes the line range (no space hack).",
        },
        delete: {
          type: "boolean",
          description: "If true, delete the range (same as content:\"\")",
        },
      },
      required: ["path", "startLine", "endLine"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.append",
    "Append (or prepend) content. Use after truncation notices with expectedPriorBytes.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        position: { type: "string", enum: ["start", "end"] },
        expectedPriorBytes: {
          type: "integer",
          description:
            "From prior write receipt; required after truncation salvage",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "fs.delete",
    "Delete a file or directory.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "shell.exec",
    "Run a finite shell command and wait for completion. Default timeoutMs is 40000; choose a larger timeout for builds, installs, scaffolds, scans, and searches. Known long installs get a safe automatic budget when omitted. Choose background:\"always\" for a normal pollable finite job or responder:true for a fire-and-continue finite job with automatic terminal delivery. Persistent commands auto-launch as normal background jobs that require shell.tail/shell.jobs plus a readiness probe. Pass background:\"never\" to force foreground and honor timeoutMs. Pass cwd instead of cd; use shell.start for persistent servers/watchers/listeners.",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "integer" },
        background: {
          type: "string",
          enum: ["auto", "never", "always"],
          description:
            "auto (default): run finite commands in the foreground and persistent commands in the background. never: always run in the foreground and honor timeoutMs. always: always run as a durable pollable job.",
        },
        responder: {
          type: "boolean",
          description:
            "Execution ownership for finite work. true: Responder fire-and-continue with automatic terminal delivery. false or omitted: keep foreground execution unless background:\"always\" explicitly requests a normal pollable job.",
        },
        parentTaskId: {
          type: "string",
          description:
            "Plan task id that owns this delegation (e.g. \"t3\"). Required whenever more than one task could own it; the Responder child is created under exactly this task.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "shell.start",
    "Start a persistent server/watcher/listener as a normal tracked background job. Returns a stable job id and persists registry/status across turns and CLI restarts. Captured output is incrementally available while this CLI process owns the child pipes; after a restart, status is reconciled but detached output pipes cannot be reattached. Launch success does not prove readiness: use shell.tail with offset/nextOffset, shell.jobs, and an application readiness probe. Do not start duplicates; use shell.stop for cleanup. Durable background jobs have no generic execution deadline and stop only naturally, by explicit cancellation, process error, or authorization expiry. Servers do not self-complete, so shell.start cannot delegate to the Responder.",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        name: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "shell.jobs",
    "List durable background jobs for this session, with running jobs first. Use before starting another long command and before finishing a task with outstanding jobs.",
    emptyObject,
    { readOnly: true },
  ),
  def(
    "shell.tail",
    "Read status and captured output from a tracked background job. For incremental polling, use stdout (default) or stderr and pass that stream's prior nextOffset as offset; continue until status is exited, failed, killed, or lost. combined is snapshot-only and rejects offset because its concatenated boundary is not a stable cursor.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        bytes: { type: "integer" },
        offset: {
          type: "integer",
          description: "Byte offset from the prior shell.tail nextOffset (default: recent tail)",
        },
        stream: {
          type: "string",
          enum: ["stdout", "stderr", "combined"],
          description: "Captured stream to read (default stdout)",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "shell.stop",
    "Stop a durable background job by id, verify termination, and persist the terminal status.",
    {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "shell.wait",
    "Block until a tracked background job reaches a terminal state (exited, failed, killed, lost), then return its exit code and output tail in one call. Use this instead of polling shell.jobs or shell.tail in a loop for a finite command such as a build, test run, or `gh run watch`: one shell.wait replaces every poll. If the wait times out the job is left running and you are told so; do other useful work and wait again with a larger timeoutMs. Never use this on a persistent server that has no terminal state.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        timeoutMs: {
          type: "integer",
          description: "Maximum time to block (default 120000, max 600000)",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "pkg.install",
    "Install a package via the OS package manager if the binary is missing.",
    {
      type: "object",
      properties: {
        tool: { type: "string" },
        checkBinary: { type: "string" },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "net.scan",
    "Validated nmap port/service scan. Put only the IP, hostname, or CIDR in target; put a port expression such as 1-1000 in ports without a -p prefix. Use profile for scan behavior: scanType syn/tcp/udp/ping, serviceDetect boolean, scripts as an array of safe NSE names (for -sC use [\"default\"]), timing T0-T5, or topPorts. Runs synchronously unless background or responder is explicitly selected.",
    {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "IP, hostname, or CIDR only; never append nmap flags",
        },
        ports: {
          type: "string",
          description: "Port or range expression, e.g. 443, 80,443, or 1-1000; omit -p",
        },
        profile: {
          type: "object",
          description: "Structured nmap options",
          properties: {
            scanType: {
              type: "string",
              enum: ["syn", "tcp", "udp", "ping"],
            },
            topPorts: { type: "integer", minimum: 1, maximum: 65535 },
            serviceDetect: { type: "boolean" },
            scripts: {
              type: "array",
              items: { type: "string", pattern: "^[A-Za-z0-9_-]+$" },
              description: "Safe NSE script names; use [\"default\"] for nmap -sC",
            },
            timing: {
              type: "string",
              enum: ["T0", "T1", "T2", "T3", "T4", "T5"],
            },
            udp: { type: "boolean" },
          },
          additionalProperties: false,
        },
        flags: {
          type: "string",
          description: "Legacy flags string",
        },
        background: {
          type: "boolean",
          description: "Run as a normal pollable durable job",
        },
        responder: {
          type: "boolean",
          description: "Delegate as a fire-and-continue Responder job",
        },
        parentTaskId: {
          type: "string",
          description:
            "Plan task id that owns this delegation (e.g. \"t3\"). Required whenever more than one task could own it; the Responder child is created under exactly this task.",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "net.context",
    "Local network context (interfaces, routes summary).",
    emptyObject,
    { readOnly: true, askMode: true },
  ),
  def(
    "net.pingSweep",
    "Discover live hosts on a subnet/CIDR.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        method: {
          type: "string",
          enum: ["auto", "nmap", "arp", "native"],
        },
        timeoutMs: { type: "integer" },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "http.fetch",
    "Raw-by-default HTTP evidence for pentest/protocol/private targets: status, full redirect response headers, final headers/cookies, decoded source body, and captured-body SHA-256. Full output is artifacted while model context is capped separately. Cross-origin redirects strip credentials unless explicitly overridden. Default no status-retries (pass retries to retry 5xx). For https://IP or self-signed lab certs use insecureTls=true (records that verification was off). TLS fingerprint: web.fetch includeTls. Not for casual public-page reading (prefer web.fetch).",
    {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        body: { type: "string" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        maxBytes: {
          type: "integer",
          minimum: 0,
          maximum: 16_777_216,
          description: "Maximum decoded response-body bytes captured (default 131072, hard cap 16777216; separate from maxOutputBytes)",
        },
        iOwnThis: { type: "boolean" },
        own: { type: "boolean" },
        retries: {
          type: "integer",
          description: "Retry transient 5xx/429 (default 0 for honest evidence)",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1_000,
          maximum: 1_800_000,
          description: "Request timeout in milliseconds (default 40000)",
        },
        responseMode: {
          type: "string",
          enum: ["raw", "readable"],
          description:
            "HTML body formatting: raw response source (default; preserves comments/tags/attributes) or readable text. Prefer web.fetch instead when only page prose is needed.",
        },
        responsePart: {
          type: "string",
          enum: ["full", "headers", "body"],
          description: "Return full evidence (default), headers/status only, or body only",
        },
        bottomLines: {
          type: "integer",
          minimum: 0,
          description: "Return only the last N rendered lines. Drops everything before them from the model's view; an omission marker is inserted. Evidence stays complete in the saved artifact.",
        },
        maxOutputBytes: {
          type: "integer",
          minimum: 0,
          description: "Strict final-output ceiling in bytes. Cuts content the model would otherwise see; a body slice is preserved but the rest is dropped. Model context is capped separately, so this only makes the view smaller.",
        },
        forwardSensitiveHeaders: {
          type: "boolean",
          description:
            "Forward Authorization, Proxy-Authorization, and Cookie across an origin-changing redirect (default false; use only when explicitly intended).",
        },
        insecureTls: {
          type: "boolean",
          description:
            "Skip TLS cert/hostname verification (https://IP, self-signed labs). Authorized testing only; evidence notes verification was disabled.",
        },
        tlsInsecure: {
          type: "boolean",
          description: "Alias of insecureTls",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "dns.lookup",
    "DNS query for a single record type. Built-in (Node resolver + DNS-over-HTTPS) — does NOT require dig/nslookup/host.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        record: {
          type: "string",
          description: "A, AAAA, MX, TXT, NS, CNAME, SOA, SRV, CAA, PTR, ANY",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "whois.lookup",
    "Registration/ownership lookup (RDAP + port-43). Built-in — does NOT require the whois binary.",
    {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "pentest.recon",
    "Bundled whois/dns/nmap recon. DNS+WHOIS use built-in resolvers (no dig/whois binaries). Prefer discrete tools when only one step is needed. Default nmap is top-100; escalate with topPorts, ports, or full for thorough engagements.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        whois: { type: "boolean" },
        dns: { type: "boolean" },
        nmap: { type: "boolean" },
        topPorts: {
          type: "integer",
          description: "nmap --top-ports N (default 100)",
        },
        ports: {
          type: "string",
          description: "nmap -p spec, e.g. 1-1000 or 80,443,8080",
        },
        full: {
          type: "boolean",
          description: "If true, scan all TCP ports (-p-)",
        },
        background: {
          type: "boolean",
          description: "Run the nmap step as a normal pollable durable job",
        },
        responder: {
          type: "boolean",
          description: "Delegate the nmap step as a fire-and-continue Responder job",
        },
        parentTaskId: {
          type: "string",
          description:
            "Plan task id that owns this delegation (e.g. \"t3\"). Required whenever more than one task could own it; the Responder child is created under exactly this task.",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "pentest.webDiscover",
    "Quick bounded probe of specific known/guessed paths (returns a high-signal status/size/redirect/tech summary). This is NOT wordlist content discovery — for real directory/content enumeration run ffuf/gobuster/feroxbuster with a wordlist as a durable background job.",
    {
      type: "object",
      properties: {
        baseUrl: { type: "string" },
        paths: { type: "array", maxItems: 100, items: { type: "string" } },
      },
      required: ["baseUrl"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "pentest.apiEnumerate",
    "Fetch and enumerate paths from an authorized OpenAPI/Swagger specification.",
    {
      type: "object",
      properties: { specUrl: { type: "string" } },
      required: ["specUrl"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "pentest.authCompare",
    "Compare the same authorized endpoint across named authentication contexts. Credentials are never echoed.",
    {
      type: "object",
      properties: {
        url: { type: "string" },
        contexts: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              headers: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["label", "headers"],
            additionalProperties: false,
          },
        },
      },
      required: ["url", "contexts"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "pentest.scanStatus",
    "Incrementally ingest a durable scan checkpoint by job id and byte offset.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        offset: { type: "integer" },
        bytes: { type: "integer" },
        stream: { type: "string", enum: ["stdout", "stderr", "combined"] },
        target: { type: "string" },
      },
      required: ["id", "target"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "web.search",
    "Search the web for current information. Use for volatile facts and research.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer" },
        fetchTop: {
          type: "integer",
          description: "Fetch top N pages (0-3)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "web.fetch",
    "Fetch a URL as readable text or metadata for research.",
    {
      type: "object",
      properties: {
        url: { type: "string" },
        maxBytes: {
          type: "integer",
          description: "Maximum page-body bytes captured from the wire; raise it when metadata reports truncated=true",
        },
        includeHeaders: { type: "boolean" },
        includeTls: { type: "boolean" },
        includeTiming: { type: "boolean" },
        includeRedirectChain: { type: "boolean" },
        responseMode: {
          type: "string",
          enum: ["readable", "raw"],
          description:
            "Body formatting: readable (default) or raw response source. Use raw for client-rendered pages whose HTML contains little readable text.",
        },
        responsePart: {
          type: "string",
          enum: ["full", "headers", "body"],
          description:
            "Return the normal full result (default), response headers/metadata only, or body only",
        },
        topLines: {
          type: "integer",
          minimum: 0,
          description: "Return only the first N rendered lines. Everything after them is dropped from the model's view behind an omission marker (combine with bottomLines for head+tail).",
        },
        bottomLines: {
          type: "integer",
          minimum: 0,
          description: "Return only the last N rendered lines. Everything before them is dropped from the model's view behind an omission marker (combine with topLines for head+tail).",
        },
        maxOutputBytes: {
          type: "integer",
          minimum: 0,
          description: "Strict byte ceiling on the final rendered output. Cuts content the model would otherwise see; a body slice is preserved but the rest is dropped.",
        },
        redactSensitive: { type: "boolean" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def("sysinfo", "OS/environment facts for this machine.", emptyObject, {
    readOnly: true,
    askMode: true,
  }),
  def(
    "tool.check",
    'Check whether binaries/tools are available on PATH (and versions). Pass tools as an array, e.g. {"tools":["nmap","ffuf"]}.',
    {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description: 'Tool names, e.g. ["nmap","ffuf"]',
        },
      },
      required: ["tools"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "tool.batch",
    "Run multiple tool calls as one batch (max 20). Default on_fail=continue (siblings keep running). Use cancel_pending for fail-fast, or cancel_on_fail/rules when later calls depend on earlier success.",
    {
      type: "object",
      properties: {
        calls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Tool name (e.g. dns.lookup)" },
              args: { type: "object", description: "Arguments for that tool" },
              id: {
                type: "string",
                description:
                  "Optional stable id for on_fail rules (default: 1-based index as string)",
              },
              cancel_on_fail: {
                type: "array",
                items: { type: "string" },
                description:
                  "If THIS call fails, cancel these sibling ids (not yet finished)",
              },
            },
            required: ["name", "args"],
            additionalProperties: false,
          },
          minItems: 1,
          maxItems: 20,
        },
        concurrency: {
          type: "integer",
          minimum: 1,
          maximum: 6,
          description:
            "Parallelism for all-safe read-only batches (default 3). Forced to 1 when mutates or on_fail is not continue.",
        },
        on_fail: {
          description:
            'Failure policy: "continue" (default), "cancel_pending" (fail-fast), or { rules: [{ if_failed, cancel, match? }] }',
          anyOf: [
            {
              type: "string",
              enum: [
                "continue",
                "cancel_pending",
                "cancel_rest",
                "fail_fast",
              ],
            },
            {
              type: "object",
              properties: {
                rules: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      if_failed: {
                        anyOf: [
                          { type: "string" },
                          { type: "array", items: { type: "string" } },
                        ],
                      },
                      cancel: {
                        anyOf: [
                          { type: "string" },
                          { type: "array", items: { type: "string" } },
                        ],
                      },
                      match: { type: "string", enum: ["any", "all"] },
                    },
                    required: ["if_failed", "cancel"],
                    additionalProperties: false,
                  },
                  minItems: 1,
                },
                mode: {
                  type: "string",
                  enum: ["continue", "cancel_pending"],
                },
                if_failed: {
                  anyOf: [
                    { type: "string" },
                    { type: "array", items: { type: "string" } },
                  ],
                },
                cancel: {
                  anyOf: [
                    { type: "string" },
                    { type: "array", items: { type: "string" } },
                  ],
                },
                match: { type: "string", enum: ["any", "all"] },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["calls"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "wordlist.find",
    "Locate wordlists on disk for fuzzing/directory scans.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        expand: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "image.ocr",
    "OCR text from an image file (fallback when vision is unavailable).",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        lang: {
          type: "string",
          description:
            "tesseract language code, or codes joined with + (default eng).",
        },
        psm: {
          type: "integer",
          minimum: 0,
          maximum: 13,
          description:
            "tesseract page-segmentation mode. Omit to try 6, 3 and 11 and keep the best result.",
        },
        preprocess: {
          type: "boolean",
          description:
            "Upscale and grayscale small images before OCR (default true). Set false to OCR the raw file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "image.view",
    "Look at an image yourself. Attaches the real image bytes to your next turn so you see the actual pixels — use this for screenshots, renders, charts, diagrams and photos, and to verify UI work you just produced. Prefer this over image.ocr whenever you need to see anything other than plain text.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Image file to look at." },
        paths: {
          type: "array",
          items: { type: "string" },
          maxItems: 4,
          description:
            "Several images to look at in one call (e.g. before/after screenshots). Use instead of path.",
        },
      },
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "pdf.read",
    "Extract text from a PDF. Uses the embedded text layer per page and OCRs only the pages that have none.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        firstPage: {
          type: "integer",
          minimum: 1,
          description: "First page to read (1-based, default 1).",
        },
        lastPage: {
          type: "integer",
          minimum: 1,
          description: "Last page to read, inclusive.",
        },
        maxPages: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description:
            "Maximum pages to read from firstPage. OCR costs up to 120s per scanned page, so bound this for long scans.",
        },
        ocr: {
          type: "string",
          enum: ["auto", "never", "always"],
          description:
            "auto (default) OCRs only pages with no text layer; never returns the text layer alone; always re-OCRs every page.",
        },
        lang: {
          type: "string",
          description: "tesseract language code for OCR pages (default eng).",
        },
        dpi: {
          type: "integer",
          minimum: 72,
          maximum: 600,
          description: "Render resolution for OCR pages (default 300).",
        },
        psm: {
          type: "integer",
          minimum: 0,
          maximum: 13,
          description:
            "tesseract page-segmentation mode. Omit to try 3, 6 and 11 and keep the best result.",
        },
        maxChars: {
          type: "integer",
          minimum: 1000,
          maximum: 1000000,
          description: "Cap on returned characters (default 200000).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "skill.load",
    "Read the full instructions of one Agent Skill listed in the AVAILABLE SKILLS block, then follow them. Load a skill when its description covers the work you are about to do — before starting that work, not after. Never guess a skill's contents, never load a skill unrelated to the task, and never load the same skill twice in a session.",
    {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact skill name from the AVAILABLE SKILLS block",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "skill.list",
    "List installed Agent Skills with descriptions and file paths. Use only when the AVAILABLE SKILLS block says entries were omitted, or when you need a skill's directory to read its bundled files.",
    {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional substring filter over name and description",
        },
      },
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "instructions.record",
    "Persist a standing instruction to .clai/INSTRUCTIONS.md so it survives context compaction. Call this as soon as the user states a rule you must keep honoring for the rest of the work — a required style, a forbidden action, a workflow you must repeat (for example \"never add comments\", \"do not push to GitHub\", \"commit after each change\"). One short imperative sentence per entry. Never record task steps, findings, plan items, or anything already in an instruction file. Use remove when the user retracts a rule.",
    {
      type: "object",
      properties: {
        add: {
          type: "array",
          items: { type: "string" },
          description:
            "Standing rules to persist, one imperative sentence each (max 12 per call)",
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description: "Existing rules to drop, by their text or 1-based number",
        },
      },
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "plan.clear",
    "Discard the active plan and all its tasks. Use when the plan should no longer be executed, needs full replacement instead of revision, or the work it tracked is being undone. After clearing, no plan exists until the next plan.create.",
    emptyObject,
    { mutates: true },
  ),
  def(
    "plan.create",
    "Create the initial durable plan or revise a draft awaiting approval. If a plan is already approved/in progress, use task.add; runtime preserves it and treats proposed new tasks as append-only.",
    {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "Short plan title (max ~8 words, one line). Not a full sentence or restatement of the user's request — put context/approach in `detail` instead.",
          maxLength: 80,
        },
        detail: { type: "string" },
        tasks: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  title: { type: "string" },
                  task: { type: "string" },
                  name: { type: "string" },
                  acceptanceCriteria: {
                    type: "string",
                    description:
                      "Observable evidence required before this task is done; state the outcome, not a preferred tool command.",
                  },
                  dependencies: {
                    type: "array",
                    items: { type: "string" },
                    description: "Task ids or aliases that must finish first",
                  },
                  resourceLocks: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional shared resources that prevent unsafe overlap",
                  },
                },
              },
            ],
          },
        },
        kind: {
          type: "string",
          description:
            "REQUIRED category for this plan — you decide it from the actual work, never leave it generic and never default to \"general\". Use one concise lowercase word (rarely two) naming the primary activity. Pick the most specific fitting label; invent a better one when none below fits. Building/coding: build, frontend, ui, webapp, api, backend, feature, refactor, bugfix, fix, debugging, testing, perf, devops, infra, deployment, migration, docs, config. Data/research: data, research, analysis. Security: security, pentest, reconnaissance, recon, osint, exploit, audit, hardening, forensics. Choose \"general\" ONLY when the work truly spans many categories with no dominant one.",
        },
      },
      required: ["goal", "tasks", "kind"],
      additionalProperties: true,
    },
    { mutates: true },
  ),
  def(
    "task.add",
    "Append one newly discovered task or child task to the active plan without rewriting existing tasks or reopening completed work.",
    {
      type: "object",
      properties: {
        title: { type: "string" },
        parentTaskId: {
          type: "string",
          description: "Optional canonical parent id from ACTIVE PLAN",
        },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Optional canonical task ids that must finish first",
        },
        resourceLocks: {
          type: "array",
          items: { type: "string" },
        },
        note: { type: "string" },
        acceptanceCriteria: {
          type: "string",
          description:
            "Observable evidence required before this task is done; describe the outcome rather than prescribing a tool.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "task.move",
    "Move an existing task without changing its id, state, evidence, or responder linkage. Use one of position, beforeTaskId, or afterTaskId.",
    {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Canonical task id or listed alias",
        },
        position: {
          type: "number",
          description: "One-based destination, for example taskId=t2 position=4",
        },
        beforeTaskId: { type: "string" },
        afterTaskId: { type: "string" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "job.read",
    "Mark one delivered Responder job result read after analysis. This is plan-independent and mandatory before a final response. Identify the receipt by jobId or notificationId; reading atomically records delivery and prevents duplicate notification of the same result revision.",
    {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Canonical background job id from the delivered result",
        },
        notificationId: {
          type: "string",
          description: "Exact notification id from the delivered Responder result",
        },
      },
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "task.read",
    "Compatibility alias for job.read using notificationId. It does not require an active plan. Call only after analyzing the delivered Responder result.",
    {
      type: "object",
      properties: {
        notificationId: {
          type: "string",
          description:
            "Exact notification id from the Responder inbox entry you finished analyzing",
        },
      },
      required: ["notificationId"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "task.update",
    "Update a plan task state. taskId MUST be t1, t2, … from the ACTIVE PLAN context (not a free-form title slug). Use state:\"pending\" to defer an in-progress foreground task before opening a different one.",
    {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Canonical id from plan context: t1, t2, t3, … (aliases accepted if listed)",
        },
        state: {
          type: "string",
          enum: ["pending", "in_progress", "done", "failed", "skipped"],
        },
        note: { type: "string" },
      },
      required: ["taskId", "state"],
      additionalProperties: true,
    },
    { mutates: true },
  ),
  def(
    "agent.handoff",
    "Hand a task that needs agent mode (writes, shell, installs) back to the user. Ask mode cannot execute mutations — use this instead of inventing write tools.",
    {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Exact task restatement for agent mode",
        },
        reason: {
          type: "string",
          description: "Short reason agent mode is required",
        },
      },
      required: ["task", "reason"],
      additionalProperties: false,
    },
  ),
  def(
    "loop.reset",
    "Reset the action-sequence loop counter so a repeated command is not blocked. Call this ONLY when you are genuinely iterating (e.g. re-running a test after editing source) and the loop guard warned you. Do not call preemptively.",
    {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  ),
  def(
    "terminal.start",
    "Start a conversation-owned interactive process or REPL and return its session id and output cursor. Use for programs that need later input; use shell.exec for finite commands and shell.start for unattended services.",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        terminalMode: {
          type: "string",
          enum: ["required", "preferred", "pipe"],
          description:
            "preferred uses a PTY when available and otherwise pipes; required refuses fallback; pipe always uses managed pipes",
        },
        columns: { type: "integer" },
        rows: { type: "integer" },
        idleTimeoutMs: { type: "integer" },
        lifetimeTimeoutMs: { type: "integer" },
        deadlineMs: { type: "integer" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "terminal.send",
    "Send exactly one text, secret, control, or EOF action to an interactive session, then return output after quiet, exit, or deadline. Secret input is prompted locally and must never be supplied in tool arguments. Continue from nextCursor; never resend when delivery is unknown or a delivered action times out while gathering output.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["text", "secret", "control", "eof"] },
        text: { type: "string" },
        secretPrompt: { type: "string" },
        submit: { type: "string", enum: ["enter", "none"] },
        control: {
          type: "string",
          enum: [
            "interrupt",
            "eof",
            "suspend",
            "escape",
            "tab",
            "backspace",
            "up",
            "down",
            "left",
            "right",
          ],
        },
        cursor: { type: "integer" },
        quietMs: { type: "integer" },
        deadlineMs: { type: "integer" },
        view: { type: "string", enum: ["plain", "encoded"] },
      },
      required: ["id", "kind"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "terminal.read",
    "Read session output from an exact cursor without sending input. Use nextCursor for gap-free continuation; waitMs may wait up to 30000ms for new output.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        cursor: { type: "integer" },
        waitMs: { type: "integer" },
        view: { type: "string", enum: ["plain", "encoded"] },
      },
      required: ["id", "cursor"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "terminal.status",
    "Return current state, cursor range, transport, and process outcome for one interactive session.",
    {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "terminal.list",
    "List interactive sessions owned by this conversation, with live sessions first.",
    emptyObject,
    { readOnly: true },
  ),
  def(
    "terminal.resize",
    "Resize a PTY-backed interactive session.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        columns: { type: "integer" },
        rows: { type: "integer" },
      },
      required: ["id", "columns", "rows"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "terminal.close",
    "Close an interactive session, terminate its process tree, and verify cleanup. Repeated close calls return the recorded terminal result.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        deadlineMs: { type: "integer" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
];

const byName = new Map(TOOL_DEFINITIONS.map((d) => [d.name, d]));
const byWire = new Map<string, ToolDefinition>();
for (const d of TOOL_DEFINITIONS) {
  byWire.set(d.wireName, d);
  const snake = toSnakeWireName(d.name);
  if (snake !== d.wireName) byWire.set(snake, d);
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return byName.get(name) ?? byWire.get(name);
}

export function getToolDefinitions(filter?: {
  askMode?: boolean;
  names?: string[];
  compact?: boolean;
}): ToolDefinition[] {
  let defs = TOOL_DEFINITIONS;
  if (filter?.askMode) {
    defs = defs.filter((d) => d.askMode);
  }
  if (filter?.names) {
    const allow = new Set(filter.names);
    defs = defs.filter((d) => allow.has(d.name));
  }
  if (filter?.compact) {
    // Core set for low-TPM models + recon/network essentials (no net.scan
    // mutator — that still needs the full set / confirm UX).
    const core = new Set([
      "fs.read",
      "fs.write",
      "fs.writeMany",
      "fs.list",
      "fs.search",
      "fs.edit",
      "fs.append",
      "fs.delete",
      "shell.exec",
      "shell.start",
      "shell.jobs",
      "shell.tail",
      "shell.wait",
      "shell.stop",
      "terminal.start",
      "terminal.send",
      "terminal.read",
      "terminal.status",
      "terminal.list",
      "terminal.resize",
      "terminal.close",
      "web.search",
      "web.fetch",
      "http.fetch",
      "dns.lookup",
      "whois.lookup",
      "net.context",
      "pentest.recon",
      "wordlist.find",
      "sysinfo",
      "tool.check",
      "image.view",
      "image.ocr",
      "skill.load",
      "skill.list",
      "instructions.record",
      "plan.create",
      "task.add",
      "task.move",
      "job.read",
      "task.read",
      "task.update",
    ]);
    defs = defs.filter((d) => core.has(d.name));
  }
  return defs.map((d) => ({ ...d }));
}

export function getCompactToolDefinitions(): ToolDefinition[] {
  return getToolDefinitions({ compact: true });
}

export function wireNameFor(canonical: string): string {
  return byName.get(canonical)?.wireName ?? toWireName(canonical);
}

export function canonicalNameFor(wire: string): string | undefined {
  return byWire.get(wire)?.name;
}

/**
 * Every registry key must have a definition; every definition must have a
 * handler unless it is a plan meta-tool.
 */
export function assertDefinitionRegistryConsistency(
  registryKeys: string[],
): void {
  const reg = new Set(registryKeys);
  const defNames = new Set(TOOL_DEFINITIONS.map((d) => d.name));
  const wires = new Set<string>();

  for (const d of TOOL_DEFINITIONS) {
    if (wires.has(d.wireName)) {
      throw new Error(`Duplicate wire name: ${d.wireName}`);
    }
    wires.add(d.wireName);
    if (!NON_REGISTRY_TOOL_NAMES.has(d.name) && !reg.has(d.name)) {
      throw new Error(
        `Definition "${d.name}" has no toolRegistry handler (and is not a meta tool)`,
      );
    }
  }
  for (const key of registryKeys) {
    if (!defNames.has(key)) {
      throw new Error(`toolRegistry key "${key}" has no ToolDefinition`);
    }
  }
}
