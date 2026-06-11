/**
 * Detect commands that are likely long-running servers, listeners, or
 * watch processes. These should be started as background jobs rather
 * than blocking the REPL.
 */

const LONG_RUNNING_PATTERNS: RegExp[] = [
  // Listeners / bind shells. Match nc/ncat with a listen flag in any flag
  // cluster form: -l, -lvnp, -nvlp, -p 4444 -l, etc.
  /\bnc(?:at)?\b[^|&;\n]*\s-[a-z]*l/i,
  /\bsocat\b.*\bLISTEN\b/i,

  // Python HTTP servers
  /\bpython3?\s+(-m\s+)?http\.server\b/i,
  /\bpython3?\s+(-m\s+)?SimpleHTTPServer\b/i,

  // Node/JS dev servers
  /\bnpm\s+run\s+dev\b/i,
  /\byarn\s+dev\b/i,
  /\bpnpm\s+dev\b/i,
  /\bbun\s+dev\b/i,
  /\bnpm\s+start\s*$/i,
  /\bnode\s+server\b/i,
  /\bnodemon\b/i,
  /\bvite\b(?!\s+build)/i,
  /\bnext\s+dev\b/i,
  /\bnuxt\s+dev\b/i,

  // Log followers / watchers
  /\btail\s+.*-[fF]\b/i,
  /\bjournalctl\s+.*-f\b/i,
  /\bwatch\s+/i,
  /\bcargo\s+watch\b/i,

  // Docker
  /\bdocker\s+logs\s+.*-f\b/i,
  /\bdocker\s+compose\s+up\b/i,
  /\bdocker-compose\s+up\b/i,

  // Python/Ruby/Go servers
  /\buvicorn\b/i,
  /\bgunicorn\b/i,
  /\bflask\s+run\b/i,
  /\brails\s+(?:server|s)\b/i,
  /\bsinatra\b/i,

  // Other dev servers
  /\bphp\s+-S\b/i,
  /\bnginx\s*$/i,
  /\bapache2?\s*$/i,

  // Tunnel / proxy
  /\bngrok\s+http\b/i,
  /\bssh\s+.*-[DLRN]\b/i,
  /\bchisel\s+(server|client)\b/i,

  // Network listeners
  /\btcpdump\b/i,
  /\bwireshark\b/i,
  /\btshark\b.*-i\b/i,

  // Databases / services run in the foreground (these block until killed)
  /\bneo4j\s+console\b/i,
  /\bmongod\b/i,
  /\bredis-server\b/i,
  /\bmysqld\b/i,
  /\bpostgres\b/i,
  /\belasticsearch\b/i,
  /\bjava\s+-jar\b/i,
];

/**
 * Detect explicit job-control backgrounding (a bare ` & ` or trailing ` &`,
 * NOT `&&`, NOT the `2>&1` fd-dup). A command that backgrounds a process
 * keeps the piped stdout open, so running it via the blocking shell executor
 * hangs the agent until the timeout — route it to the job manager instead.
 */
function backgroundsAProcess(command: string): boolean {
  return /(?:^|[^&\d>])\s&(?:\s|$)/.test(command);
}

/**
 * Returns true if the command appears to be a long-running process that
 * should not block the foreground shell. This is a heuristic — false
 * negatives are safer than false positives.
 */
export function looksLongRunning(command: string): boolean {
  return (
    backgroundsAProcess(command) ||
    LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(command))
  );
}
