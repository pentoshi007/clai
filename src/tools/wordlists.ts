/**
 * Locate a wordlist file for fuzzing tools (ffuf, gobuster, wfuzz, dirb).
 *
 * The common failure mode: the agent hardcodes /usr/share/wordlists/... —
 * which only exists on Kali — then ffuf fails with "no such file" on macOS
 * or Windows. This tool checks the well-known install locations for each OS
 * first, then falls back to a bounded filesystem search (capped depth,
 * capped time, permission errors suppressed) instead of scanning the whole
 * disk or letting stderr noise flood the model's context.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../types.js";

/** Well-known wordlist roots, checked in order, before any filesystem search. */
function knownRoots(): string[] {
  const home = homedir();
  const common = [
    join(home, "wordlists"),
    join(home, "SecLists"),
    join(home, "seclists"),
    join(home, ".wordlists"),
  ];
  if (platform() === "win32") {
    return [
      ...common,
      "C:\\SecLists",
      "C:\\Tools\\SecLists",
      "C:\\Tools\\wordlists",
      join(home, "Tools", "SecLists"),
    ];
  }
  if (platform() === "darwin") {
    return [
      ...common,
      "/opt/homebrew/share/seclists",
      "/opt/homebrew/share/wordlists",
      "/usr/local/share/seclists",
      "/usr/local/share/wordlists",
      "/usr/share/wordlists", // rare, but harmless to check
      "/usr/share/seclists",
    ];
  }
  // Linux (Kali ships these by default; other distros vary)
  return [
    ...common,
    "/usr/share/wordlists",
    "/usr/share/seclists",
    "/usr/share/dirb/wordlists",
    "/usr/share/dirbuster/wordlists",
    "/opt/SecLists",
  ];
}

/** Name fragments the caller is most likely after, mapped to common filenames. */
const NAME_ALIASES: Record<string, string[]> = {
  common: ["common.txt", "common.txt.gz"],
  "common.txt": ["common.txt"],
  big: ["big.txt"],
  medium: ["directory-list-2.3-medium.txt"],
  small: ["directory-list-2.3-small.txt"],
  rockyou: ["rockyou.txt", "rockyou.txt.gz"],
  subdomains: ["subdomains-top1million-5000.txt", "subdomains-top1million-20000.txt"],
  "raft-small": ["raft-small-words.txt", "raft-small-directories.txt"],
  "raft-medium": ["raft-medium-words.txt", "raft-medium-directories.txt"],
};

function candidateFilenames(query: string): string[] {
  const lower = query.toLowerCase().trim();
  if (NAME_ALIASES[lower]) return NAME_ALIASES[lower]!;
  // Bare filename already (has an extension) — search for it verbatim too.
  return [query];
}

/**
 * Bounded, quiet directory search: fixed max depth, short timeout, and
 * permission/IO errors on individual entries are swallowed rather than
 * surfaced — the caller only cares about hits, not the noise of scanning
 * directories it can't read.
 */
function searchRoot(root: string, filenames: string[], maxDepth: number): string[] {
  if (!existsSync(root)) return [];
  const hits: string[] = [];
  const isWindows = platform() === "win32";
  try {
    if (isWindows) {
      // PowerShell Get-ChildItem with -ErrorAction SilentlyContinue mirrors
      // the 2>/dev/null suppression used on POSIX below.
      const namePattern = filenames.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
      const script =
        `Get-ChildItem -Path '${root.replace(/'/g, "''")}' -Recurse -File ` +
        `-Depth ${maxDepth} -ErrorAction SilentlyContinue ` +
        `| Where-Object { @(${namePattern}) -contains $_.Name } ` +
        `| Select-Object -First 20 -ExpandProperty FullName`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        timeout: 8_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      hits.push(...out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    } else {
      const nameExpr = filenames.flatMap((f, i) => (i === 0 ? ["-name", f] : ["-o", "-name", f]));
      const out = execFileSync(
        "find",
        [root, "-maxdepth", String(maxDepth), "-type", "f", "(", ...nameExpr, ")"],
        { timeout: 8_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      hits.push(...out.split("\n").map((l) => l.trim()).filter(Boolean));
    }
  } catch {
    // Timeout, missing `find`/powershell, or a permission error on the root
    // itself — treat as "no hits here" rather than surfacing noise.
  }
  return hits;
}

export interface WordlistFindArgs {
  query: string;
  /** Search beyond the known roots if nothing is found there. Default true. */
  expand?: boolean | undefined;
}

export async function wordlistFind(args: WordlistFindArgs): Promise<ToolResult> {
  const query = args.query?.trim();
  if (!query) {
    return { ok: false, output: "wordlist.find requires a query, e.g. \"common.txt\" or \"rockyou\".", exitCode: 1 };
  }
  const filenames = candidateFilenames(query);
  const roots = knownRoots();

  // Pass 1: well-known install locations for this OS, shallow (they're
  // already wordlist directories, so a shallow walk is enough and fast).
  for (const root of roots) {
    const hits = searchRoot(root, filenames, 6);
    if (hits.length > 0) {
      return {
        ok: true,
        output: `Found in a known wordlist location:\n${hits.join("\n")}`,
        exitCode: 0,
      };
    }
  }

  if (args.expand === false) {
    return {
      ok: false,
      output:
        `No match for "${query}" in known wordlist locations for ${platform()}.\n` +
        `Checked: ${roots.join(", ")}\n` +
        `Retry with expand=true to broaden the search, or pkg.install seclists.`,
      exitCode: 1,
    };
  }

  // Pass 2: broaden to common user/download dirs before giving up — never
  // the whole filesystem, to keep this fast and quiet.
  const home = homedir();
  const broaderRoots = [
    join(home, "Downloads"),
    join(home, "Desktop"),
    join(home, "tools"),
    join(home, "Tools"),
    "/opt",
  ].filter((r) => !roots.includes(r));

  for (const root of broaderRoots) {
    const hits = searchRoot(root, filenames, 4);
    if (hits.length > 0) {
      return {
        ok: true,
        output: `Found outside the standard wordlist locations:\n${hits.join("\n")}`,
        exitCode: 0,
      };
    }
  }

  return {
    ok: false,
    output:
      `No wordlist matching "${query}" found on this ${platform()} machine.\n` +
      `Checked known locations and common user directories.\n` +
      `Install one: pkg.install seclists (Linux/macOS) or clone https://github.com/danielmiessler/SecLists.`,
    exitCode: 1,
  };
}
