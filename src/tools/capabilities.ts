import { execFile } from "node:child_process";
import { findExecutable } from "../os/command.js";
import type { ToolResult } from "../types.js";

export interface ToolAvailability {
  name: string;
  available: boolean;
  path?: string | undefined;
  version?: string | undefined;
  installHint?: string | undefined;
}

const VERSION_COMMANDS: Record<string, string[]> = {
  nmap: ["nmap", "--version"],
  ffuf: ["ffuf", "-V"],
  curl: ["curl", "--version"],
  python3: ["python3", "--version"],
  python: ["python", "--version"],
  node: ["node", "--version"],
  go: ["go", "version"],
  dig: ["dig", "-v"],
  whois: ["whois", "--version"],
  gobuster: ["gobuster", "version"],
  nikto: ["nikto", "-Version"],
  sqlmap: ["sqlmap", "--version"],
  hydra: ["hydra", "-h"],
  rg: ["rg", "--version"],
  jq: ["jq", "--version"],
  git: ["git", "--version"],
  docker: ["docker", "--version"],
  kubectl: ["kubectl", "version", "--client", "--short"],
  tesseract: ["tesseract", "--version"],
};

const INSTALL_HINTS: Record<string, string> = {
  nmap: "pkg.install nmap",
  ffuf: "go install github.com/ffuf/ffuf/v2@latest",
  gobuster: "go install github.com/OJ/gobuster/v3@latest",
  nikto: "pkg.install nikto",
  sqlmap: "pkg.install sqlmap",
  hydra: "pkg.install hydra",
  rg: "pkg.install ripgrep",
  jq: "pkg.install jq",
  dig: "optional — dns.lookup uses built-in resolver (no dig needed)",
  whois: "optional — whois.lookup uses RDAP/port-43 (no whois binary needed)",
  nslookup: "optional — use dns.lookup (built-in)",
  host: "optional — use dns.lookup (built-in)",
  subfinder:
    "go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest",
  httpx: "go install github.com/projectdiscovery/httpx/cmd/httpx@latest",
  nuclei: "go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest",
  tesseract: "pkg.install tesseract",
};

const BUILTIN_COVERED = new Set([
  "dig",
  "whois",
  "nslookup",
  "host",
  "hostid",
]);

export function isProjectLocalNodeBin(path: string): boolean {
  return /(?:^|[/\\])node_modules[/\\]\.bin[/\\]/i.test(path);
}

async function findCommand(name: string): Promise<string | undefined> {
  const found = await findExecutable(name);
  return found && !isProjectLocalNodeBin(found) ? found : undefined;
}

const versionCache = new Map<string, string | undefined>();

async function getVersion(
  name: string,
  resolvedPath?: string,
): Promise<string | undefined> {
  const spec = VERSION_COMMANDS[name];
  if (!spec) return undefined;
  const cacheKey = `${name}\u0000${resolvedPath ?? ""}`;
  if (versionCache.has(cacheKey)) return versionCache.get(cacheKey);
  const version = await new Promise<string | undefined>((resolve) => {
    const argv0 = resolvedPath ?? spec[0]!;
    execFile(
      argv0,
      spec.slice(1),
      {
        timeout: 5_000,
        encoding: "utf8",
        env: { ...process.env, PATH: process.env.PATH ?? "" },
      },
      (error, stdout, stderr) => {
        if (error && !stdout && !stderr) {
          resolve(undefined);
          return;
        }
        const result = String(stdout || stderr);
        const lines = result.split("\n").filter(Boolean);
        for (const line of lines) {
          const ver = /(\d+\.\d+[.\w-]*)/.exec(line);
          if (ver?.[1]) {
            resolve(ver[1]);
            return;
          }
        }
        resolve(lines[0]?.trim().slice(0, 60));
      },
    );
  });
  versionCache.set(cacheKey, version);
  return version;
}

export async function checkTool(name: string): Promise<ToolAvailability> {
  const path = await findCommand(name);
  if (!path) {
    return {
      name,
      available: false,
      installHint: INSTALL_HINTS[name],
    };
  }
  const version = await getVersion(name, path);
  return {
    name,
    available: true,
    path,
    version,
  };
}

export async function checkTools(names: string[]): Promise<ToolAvailability[]> {
  return Promise.all(names.map((name) => checkTool(name)));
}

export async function toolCheckHandler(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const toolsRaw =
    args.tools ??
    args.name ??
    args.binary ??
    args.tool;
  let names: string[];
  if (Array.isArray(toolsRaw)) {
    names = toolsRaw.filter((t): t is string => typeof t === "string");
  } else if (typeof toolsRaw === "string") {
    names = toolsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  } else {
    return {
      ok: false,
      output:
        'tool.check expects { "tools": ["nmap", "ffuf", ...] } or { "tools": "nmap,ffuf" }',
      exitCode: 1,
    };
  }

  if (names.length === 0) {
    return { ok: false, output: "No tool names provided.", exitCode: 1 };
  }
  if (names.length > 20) {
    return {
      ok: false,
      output: "tool.check accepts at most 20 tools per call.",
      exitCode: 1,
    };
  }

  const results = await checkTools(names);
  const LOCAL_OPTIONAL = new Set([
    "vite",
    "next",
    "nuxt",
    "tsc",
    "eslint",
    "prettier",
    "webpack",
    "parcel",
  ]);
  const SUBSTITUTE_FAMILIES: string[][] = [
    ["npm", "yarn", "pnpm", "bun"],
    ["pip", "pip3", "poetry", "uv", "pipenv"],
    ["python", "python3"],
    ["node", "nodejs"],
    ["ffuf", "gobuster", "feroxbuster", "dirsearch", "wfuzz"],
  ];

  function familyOf(name: string): string[] | undefined {
    const n = name.toLowerCase();
    return SUBSTITUTE_FAMILIES.find((f) => f.includes(n));
  }

  async function substituteAvailable(name: string): Promise<boolean> {
    const family = familyOf(name);
    if (!family) return false;
    if (results.some((r) => family.includes(r.name.toLowerCase()) && r.available)) {
      return true;
    }
    for (const alt of family) {
      if (alt === name.toLowerCase()) continue;
      if (await findCommand(alt)) return true;
    }
    return false;
  }

  async function isSoftMissing(name: string): Promise<boolean> {
    const n = name.toLowerCase();
    if (LOCAL_OPTIONAL.has(n)) return true;
    if (BUILTIN_COVERED.has(n)) return true;
    if (["yarn", "pnpm", "bun", "pipenv", "poetry", "uv"].includes(n)) return true;
    if (await substituteAvailable(n)) return true;
    return false;
  }

  const softMissing = await Promise.all(results.map((r) => isSoftMissing(r.name)));
  const lines = results.map((r, index) => {
    if (r.available) {
      const ver = r.version ? ` (${r.version})` : "";
      return `✓ ${r.name}${ver} — ${r.path}`;
    }
    const hint = r.installHint ? ` — install: ${r.installHint}` : "";
    if (LOCAL_OPTIONAL.has(r.name.toLowerCase())) {
      return (
        `○ ${r.name} — not on global PATH (ok for scaffold: use npx / project bin after install; ` +
        `project-local node_modules/.bin is ignored)${hint}`
      );
    }
    if (BUILTIN_COVERED.has(r.name.toLowerCase())) {
      return `○ ${r.name} — not found (optional; use dns.lookup / whois.lookup — built-in, no binary needed)${hint ? ` ${hint}` : ""}`;
    }
    if (softMissing[index]) {
      const fam = familyOf(r.name);
      const alts = fam
        ? fam.filter((x) => x !== r.name.toLowerCase()).join("/")
        : "an alternative";
      return `○ ${r.name} — not found (optional; ${alts} can substitute)${hint}`;
    }
    return `✗ ${r.name} — not found${hint}`;
  });

  const hardMissing = results.filter((r, index) => !r.available && !softMissing[index]);
  const footer =
    hardMissing.length > 0
      ? `\n\nHard-missing (required): ${hardMissing.map((r) => r.name).join(", ")}. ` +
        `Install or use a substitute before relying on them.`
      : results.some((r) => !r.available)
        ? `\n\nNote: ○ = optional/substitute available — overall check OK. Proceed with the tools marked ✓.`
        : "";
  return {
    ok: true,
    output: lines.join("\n") + footer,
    exitCode: 0,
  };
}
