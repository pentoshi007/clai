/**
 * Locate wordlist files for fuzzing tools. The goal is simple: if a wordlist
 * exists anywhere reasonable on disk, find it — regardless of how the model
 * phrased the query.
 *
 * Models rarely pass an exact filename. They pass things like
 * "directory common medium", "rockyou password list", or "medium directory
 * wordlist for fuzzing". So instead of a naive exact `-name` match we:
 *   1. Tokenize the query into keywords (dropping noise words like "wordlist").
 *   2. Expand well-known aliases (common → common.txt, medium →
 *      directory-list-2.3-medium.txt, rockyou → rockyou.txt/.gz, …).
 *   3. Build case-insensitive substring globs (`*keyword*.txt`) so partial and
 *      differently-cased names still match.
 *   4. Search progressively wider: known install roots → broader user dirs →
 *      locate DB → full filesystem → cached-credential sudo — stopping at the
 *      first pass that yields hits.
 *
 * All external searches run through async execFile (never execFileSync) so a
 * slow `find /` can never block the render loop, and sudo is only ever invoked
 * with `-n` (cached credentials) — it must NEVER inherit the TTY to prompt for
 * a password, which corrupts the OpenTUI screen and steals the keyboard.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../types.js";

const execFileAsync = promisify(execFile);

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";
function getHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

const MAX_HITS = 60;

async function runCapture(
  command: string,
  argv: string[],
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, argv, {
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    return stdout ?? "";
  } catch (error) {
    const stdout = (error as { stdout?: string } | undefined)?.stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}


function knownRoots(): string[] {
  const home = getHome();
  const common = [
    join(home, "wordlists"),
    join(home, "SecLists"),
    join(home, "seclists"),
    join(home, ".wordlists"),
    join(home, "Documents", "wordlists"),
    join(home, "Documents", "SecLists"),
    join(home, "projects"),
    join(home, "github"),
    join(home, "repos"),
    join(home, "pentesting"),
    join(home, "pentest"),
  ];
  if (IS_WIN) {
    return [
      ...common,
      "C:\\SecLists",
      "C:\\Tools\\SecLists",
      "C:\\Tools\\wordlists",
      join(home, "Tools", "SecLists"),
    ];
  }
  if (IS_MAC) {
    return [
      ...common,
      "/opt/homebrew/share/seclists",
      "/opt/homebrew/share/wordlists",
      "/opt/homebrew/share/nmap/nselib/data",
      "/usr/local/share/seclists",
      "/usr/local/share/wordlists",
      "/opt/local/share/seclists",
      "/opt/local/share/wordlists",
      "/usr/share/wordlists",
      "/usr/share/seclists",
    ];
  }
  return [
    ...common,
    "/usr/share/wordlists",
    "/usr/share/seclists",
    "/usr/share/dirb/wordlists",
    "/usr/share/dirbuster/wordlists",
    "/usr/share/wfuzz/wordlist",
    "/opt/SecLists",
    "/opt/wordlists",
    "/var/wordlists",
    "/pentest",
  ];
}


const NAME_ALIASES: Record<string, string[]> = {
  common: ["common.txt"],
  "common.txt": ["common.txt"],
  big: ["big.txt"],
  medium: ["directory-list-2.3-medium.txt"],
  "directory-medium": ["directory-list-2.3-medium.txt"],
  small: ["common.txt", "quickhits.txt", "raft-small-directories.txt", "directory-list-2.3-small.txt"],
  short: ["common.txt", "quickhits.txt", "raft-small-directories.txt", "directory-list-2.3-small.txt"],
  quick: ["quickhits.txt", "common.txt", "raft-small-directories.txt"],
  "directory-small": ["common.txt", "quickhits.txt", "raft-small-directories.txt", "directory-list-2.3-small.txt"],
  directory: ["common.txt", "quickhits.txt", "raft-small-directories.txt", "directory-list-2.3-small.txt"],
  directories: ["common.txt", "quickhits.txt", "raft-small-directories.txt", "directory-list-2.3-small.txt"],
  rockyou: ["rockyou.txt", "rockyou.txt.gz"],
  passwords: ["rockyou.txt", "rockyou.txt.gz"],
  password: ["rockyou.txt", "rockyou.txt.gz"],
  subdomains: [
    "subdomains-top1million-5000.txt",
    "subdomains-top1million-20000.txt",
    "subdomains-top1million-110000.txt",
  ],
  subdomain: ["subdomains-top1million-5000.txt"],
  dns: ["subdomains-top1million-5000.txt"],
  vhosts: ["subdomains-top1million-5000.txt"],
  "raft-small": [
    "raft-small-words.txt",
    "raft-small-directories.txt",
    "raft-small-files.txt",
  ],
  "raft-medium": [
    "raft-medium-words.txt",
    "raft-medium-directories.txt",
    "raft-medium-files.txt",
  ],
  "raft-large": [
    "raft-large-words.txt",
    "raft-large-directories.txt",
    "raft-large-files.txt",
  ],
  quickhits: ["quickhits.txt"],
  api: ["api-endpoints.txt", "actions-lowercase.txt"],
  usernames: ["top-usernames-shortlist.txt", "xato-net-10-million-usernames.txt"],
  users: ["top-usernames-shortlist.txt"],
  fuzz: ["fuzz-Bo0oM.txt"],
  fuzzing: ["fuzz-Bo0oM.txt"],
  lfi: ["LFI-Jhaddix.txt"],
};

const WL_EXTS = ["txt", "lst", "dic", "words", "wordlist", "list", "gz"];
const WL_FILE_RE = /\.(txt|lst|dic|words|wordlist|list|gz)$/i;

const STOPWORDS = new Set([
  "wordlist", "wordlists", "list", "lists", "the", "a", "an", "and", "or",
  "for", "of", "to", "in", "on", "find", "search", "locate", "please", "get",
  "me", "with", "some", "any", "best", "top", "file", "files", "txt", "using",
  "use", "used", "need", "want", "looking", "look", "good", "default", "path",
  "scan", "scanning", "fuzzing",
]);

interface SearchPlan {
  names: string[];
  globs: string[];
  broad: string[];
  keywords: string[];
}

function looksLikeFilename(s: string): boolean {
  return !/\s/.test(s) && /\.[a-z0-9]{1,8}(\.[a-z0-9]{1,4})?$/i.test(s);
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

function buildSearchPlan(query: string): SearchPlan {
  const lower = query.toLowerCase().trim();
  const names = new Set<string>();
  const globs = new Set<string>();
  const broad = new Set<string>();

  if (looksLikeFilename(lower)) names.add(lower);
  for (const a of NAME_ALIASES[lower] ?? []) names.add(a);

  const rawTokens = tokenize(query);
  let keywords = rawTokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (keywords.length === 0) keywords = rawTokens.filter((t) => t.length >= 3);
  if (keywords.length === 0) keywords = rawTokens.slice();
  keywords = [...new Set(keywords)].slice(0, 6);

  for (const kw of keywords) {
    for (const a of NAME_ALIASES[kw] ?? []) names.add(a);
    for (const ext of WL_EXTS) globs.add(`*${kw}*.${ext}`);
    broad.add(`*${kw}*`);
  }

  if (names.size === 0 && globs.size === 0) names.add(query);

  return {
    names: [...names],
    globs: [...globs],
    broad: [...broad],
    keywords,
  };
}


function parseLines(raw: string): string[] {
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

function buildFindNameExpr(patterns: string[]): string[] {
  return patterns.flatMap((p, i) => (i === 0 ? ["-iname", p] : ["-o", "-iname", p]));
}

function psPatternArray(patterns: string[]): string {
  return patterns.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
}

async function searchRoot(
  root: string,
  patterns: string[],
  maxDepth: number,
): Promise<string[]> {
  if (!existsSync(root) || patterns.length === 0) return [];
  if (IS_WIN) {
    const script =
      `$pats=@(${psPatternArray(patterns)}); ` +
      `Get-ChildItem -Path '${root.replace(/'/g, "''")}' -Recurse -File ` +
      `-Depth ${maxDepth} -ErrorAction SilentlyContinue ` +
      `| Where-Object { $n=$_.Name; @($pats | Where-Object { $n -like $_ }).Count -gt 0 } ` +
      `| Select-Object -First ${MAX_HITS} -ExpandProperty FullName`;
    return parseLines(
      await runCapture("powershell.exe", ["-NoProfile", "-Command", script], 8_000),
    );
  }
  const nameExpr = buildFindNameExpr(patterns);
  return parseLines(
    await runCapture(
      "find",
      [root, "-maxdepth", String(maxDepth), "-type", "f", "(", ...nameExpr, ")"],
      8_000,
    ),
  );
}

async function searchLocate(plan: SearchPlan): Promise<string[]> {
  if (IS_WIN) return [];
  const terms = dedupe([...plan.names, ...plan.keywords]);
  const hits: string[] = [];
  for (const term of terms) {
    const lines = parseLines(
      await runCapture("locate", ["-i", "-l", String(MAX_HITS), term], 5_000),
    );
    for (const line of lines) {
      if (WL_FILE_RE.test(line) || plan.names.some((n) => line.toLowerCase().endsWith(n.toLowerCase()))) {
        hits.push(line);
      }
    }
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

async function searchFullFilesystem(patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  if (IS_WIN) {
    const drives = parseLines(
      (
        await runCapture(
          "powershell.exe",
          ["-NoProfile", "-Command", "(Get-PSDrive -PSProvider FileSystem).Root -join ','"],
          3_000,
        )
      ).replace(/,/g, "\n"),
    );
    if (drives.length === 0) return [];
    const paths = drives.map((d) => `'${d.replace(/'/g, "''")}'`).join(",");
    const script =
      `$pats=@(${psPatternArray(patterns)}); ` +
      `Get-ChildItem -Path ${paths} -Recurse -File ` +
      `-Depth 6 -ErrorAction SilentlyContinue ` +
      `| Where-Object { $n=$_.Name; @($pats | Where-Object { $n -like $_ }).Count -gt 0 } ` +
      `| Select-Object -First ${MAX_HITS} -ExpandProperty FullName`;
    return parseLines(
      await runCapture("powershell.exe", ["-NoProfile", "-Command", script], 15_000),
    );
  }
  const nameExpr = buildFindNameExpr(patterns);
  return parseLines(
    await runCapture(
      "find",
      ["/", "-maxdepth", "8", "-type", "f", "(", ...nameExpr, ")"],
      15_000,
    ),
  );
}

/**
 * Cached-credential sudo search only. We try `sudo -n find /` which succeeds
 * silently when a sudo timestamp is already valid and fails instantly (no
 * prompt) otherwise. We deliberately do NOT fall back to an interactive
 * `sudo find`: inheriting the TTY makes sudo print "Password:" straight to the
 * terminal, corrupting the TUI, freezing the keyboard, and never routing
 * through clai's secure modal. POSIX only.
 */
async function searchSudo(patterns: string[]): Promise<string[]> {
  if (IS_WIN || patterns.length === 0) return [];
  const nameExpr = buildFindNameExpr(patterns);
  const findArgs = ["/", "-maxdepth", "8", "-type", "f", "(", ...nameExpr, ")"];
  return parseLines(await runCapture("sudo", ["-n", "find", ...findArgs], 15_000));
}


function safeFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function rankHits(hits: string[], query: string): string[] {
  const lowerQuery = query.toLowerCase();
  const shortIntent = /\b(?:short|small|quick|common)\b/.test(lowerQuery);
  const webContentIntent =
    shortIntent ||
    /\b(?:dir(?:ectory|ectories)?|content|path|endpoint|web)\b/.test(lowerQuery);
  const credentialIntent = /\b(?:password|credential|username|user)\b/.test(lowerQuery);
  const mediumIntent = /\bmedium\b/.test(lowerQuery);
  const candidates = dedupe(hits).filter(
    (path) =>
      !webContentIntent ||
      credentialIntent ||
      !/password|username|credential/i.test(path),
  );
  const score = (path: string): number => {
    const lower = path.toLowerCase();
    let value = 0;
    if (webContentIntent) {
      if (/discovery[/\\]web-content|dirb|dirbuster|raft-.*director|directory-list|quickhits|common\.txt/.test(lower)) value += 100;
      if (/password|username|credential/.test(lower)) value -= 500;
    }
    if (shortIntent && /quickhits|common\.txt|raft-small|directory-list-2\.3-small/.test(lower)) value += 200;
    if (mediumIntent && /medium/.test(lower)) value += 300;
    return value;
  };
  return candidates.sort((left, right) => {
    const scoreDelta = score(right) - score(left);
    if (scoreDelta !== 0) return scoreDelta;
    if (shortIntent) return safeFileSize(left) - safeFileSize(right);
    return left.localeCompare(right);
  });
}

function found(hits: string[], source: string, query: string): ToolResult {
  const uniq = rankHits(hits, query).slice(0, MAX_HITS);
  const label = `${source} (${uniq.length} match${uniq.length === 1 ? "" : "es"})`;
  const recommendation = uniq[0]
    ? `Recommended first match for this intent: ${uniq[0]} (${safeFileSize(uniq[0]).toLocaleString()} bytes)`
    : "";
  return {
    ok: true,
    output: `${label}:\n${recommendation}\n${uniq.join("\n")}`,
    exitCode: 0,
  };
}


export interface WordlistFindArgs {
  query: string;
  expand?: boolean | undefined;
}

export async function wordlistFind(args: WordlistFindArgs): Promise<ToolResult> {
  const query = args.query?.trim();
  if (!query) {
    return {
      ok: false,
      output: 'wordlist.find requires a query, e.g. "common.txt", "rockyou", or "medium directory list".',
      exitCode: 1,
    };
  }

  const plan = buildSearchPlan(query);
  const precisePatterns = dedupe([...plan.names, ...plan.globs]);
  const rootPatterns = dedupe([...plan.names, ...plan.globs, ...plan.broad]);
  const roots = knownRoots();

  for (const root of roots) {
    const hits = rankHits(await searchRoot(root, rootPatterns, 6), query);
    if (hits.length > 0) return found(hits, "Found in a known wordlist location", query);
  }

  if (args.expand === false) {
    return {
      ok: true,
      output:
        `No match for "${query}" in known wordlist locations for ${platform()}.\n` +
        `Tried keywords: ${plan.keywords.join(", ") || query}.\n` +
        `Checked: ${roots.join(", ")}\n` +
        `Retry with expand=true to broaden the search, or pkg.install seclists.`,
      exitCode: 0,
    };
  }

  const home = getHome();
  const broaderRoots = [
    join(home, "Downloads"), join(home, "Desktop"),
    join(home, "Documents"), join(home, "Projects"),
    join(home, "tools"), join(home, "Tools"),
    join(home, "github"), join(home, "repos"),
    join(home, "pentesting"), join(home, "pentest"),
    join(home, "src"), join(home, "code"),
    "/opt",
  ].filter((r) => !roots.includes(r));

  for (const root of broaderRoots) {
    const hits = rankHits(await searchRoot(root, precisePatterns, 5), query);
    if (hits.length > 0) return found(hits, "Found in user directory", query);
  }

  const locateHits = rankHits(await searchLocate(plan), query);
  if (locateHits.length > 0) return found(locateHits, "Found via locate database", query);

  const fsHits = rankHits(await searchFullFilesystem(precisePatterns), query);
  if (fsHits.length > 0) return found(fsHits, "Found via full filesystem search", query);

  // Pass 5: cached-credential sudo search (POSIX only, never prompts).
  const sudoHits = rankHits(await searchSudo(precisePatterns), query);
  if (sudoHits.length > 0) return found(sudoHits, "Found via elevated filesystem search", query);

  return {
    ok: true,
    output:
      `No wordlist matching "${query}" found after searching known locations, ` +
      `the locate database, and the filesystem (keywords: ${plan.keywords.join(", ") || query}).\n` +
      `Install one: pkg.install seclists (Linux/macOS) or clone https://github.com/danielmiessler/SecLists.\n` +
      `If credentials are not cached, an elevated search was skipped (clai never opens a raw sudo prompt).`,
    exitCode: 0,
  };
}
