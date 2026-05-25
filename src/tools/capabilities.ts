import { execSync } from "node:child_process";
import { platform } from "node:os";
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
  dig: "pkg.install dnsutils (or bind-utils)",
  subfinder: "go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest",
  httpx: "go install github.com/projectdiscovery/httpx/cmd/httpx@latest",
  nuclei: "go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest",
};

function findCommand(name: string): string | undefined {
  try {
    const cmd =
      platform() === "win32" ? `where.exe ${name}` : `command -v ${name}`;
    const result = execSync(cmd, {
      timeout: 3_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim().split("\n")[0]?.trim();
  } catch {
    return undefined;
  }
}

function getVersion(name: string): string | undefined {
  const spec = VERSION_COMMANDS[name];
  if (!spec) return undefined;
  try {
    const result = execSync(spec.join(" "), {
      timeout: 5_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Take the first non-empty line containing a version-like pattern
    const lines = result.split("\n").filter(Boolean);
    for (const line of lines) {
      const ver = /(\d+\.\d+[.\w-]*)/.exec(line);
      if (ver?.[1]) return ver[1];
    }
    return lines[0]?.trim().slice(0, 60);
  } catch {
    return undefined;
  }
}

export async function checkTool(name: string): Promise<ToolAvailability> {
  const path = findCommand(name);
  if (!path) {
    return {
      name,
      available: false,
      installHint: INSTALL_HINTS[name],
    };
  }
  const version = getVersion(name);
  return {
    name,
    available: true,
    path,
    version,
  };
}

export async function checkTools(
  names: string[],
): Promise<ToolAvailability[]> {
  return Promise.all(names.map((name) => checkTool(name)));
}

export async function toolCheckHandler(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const toolsRaw = args.tools;
  let names: string[];
  if (Array.isArray(toolsRaw)) {
    names = toolsRaw.filter((t): t is string => typeof t === "string");
  } else if (typeof toolsRaw === "string") {
    names = toolsRaw.split(",").map((t) => t.trim()).filter(Boolean);
  } else {
    return {
      ok: false,
      output: 'tool.check expects { "tools": ["nmap", "ffuf", ...] } or { "tools": "nmap,ffuf" }',
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
  const lines = results.map((r) => {
    if (r.available) {
      const ver = r.version ? ` (${r.version})` : "";
      return `✓ ${r.name}${ver} — ${r.path}`;
    }
    const hint = r.installHint ? ` — install: ${r.installHint}` : "";
    return `✗ ${r.name} — not found${hint}`;
  });

  const allAvailable = results.every((r) => r.available);
  return {
    ok: allAvailable,
    output: lines.join("\n"),
    exitCode: allAvailable ? 0 : 1,
  };
}
