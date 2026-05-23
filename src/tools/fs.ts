import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { execa } from "execa";
import type { ToolResult } from "../types.js";
import { getConfig } from "../store/config.js";
import { redactSecrets } from "../llm/provider.js";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

function resolvePath(path: string): string {
  return resolve(expandHome(path));
}

function configuredRoots(): string[] {
  return [
    ...getConfig().sandboxRoots.map((root) => resolve(expandHome(root))),
    resolve(process.cwd()),
  ];
}

function isWithinRoots(resolved: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function isForbiddenSecretPath(resolved: string): boolean {
  const lower = resolved.toLowerCase().replace(/\\/g, "/");
  const home = resolve(homedir()).toLowerCase().replace(/\\/g, "/");
  const relativeHome = lower.startsWith(home) ? lower.slice(home.length) : lower;
  const secretSegments = [
    "/.ssh/",
    "/.gnupg/",
    "/.aws/",
    "/.kube/",
    "/.docker/",
    "/.config/gcloud/",
    "/.clai/keys.json",
  ];
  if (secretSegments.some((segment) => relativeHome.includes(segment))) return true;
  return /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.key)$/i.test(
    lower,
  );
}

function ensureReadAllowed(path: string): string {
  const resolved = resolvePath(path);
  if (isForbiddenSecretPath(resolved)) {
    throw new Error(`Read blocked — path looks like a secret: ${path}`);
  }
  if (!isWithinRoots(resolved, configuredRoots())) {
    throw new Error(`Read blocked — path is outside approved roots: ${path}`);
  }
  return resolved;
}

function ensureWriteAllowed(path: string): string {
  const resolved = resolvePath(path);
  const roots = [
    ...getConfig().sandboxRoots.map((root) => resolve(expandHome(root))),
    resolve(homedir()),
  ];
  if (!isWithinRoots(resolved, roots)) {
    throw new Error(`Write blocked — path is outside approved roots: ${path}`);
  }
  return resolved;
}

export async function fsRead(path: string): Promise<ToolResult> {
  const resolved = ensureReadAllowed(path);
  const info = await stat(resolved);
  const maxBytes = 128 * 1024;
  if (info.size <= maxBytes) {
    const content = redactSecrets(await readFile(resolved, "utf8"));
    return { ok: true, output: content, stats: { bytesRead: info.size, bytesShown: Buffer.byteLength(content) } };
  }
  const handle = await open(resolved, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const preview = redactSecrets(buffer.subarray(0, bytesRead).toString("utf8"));
    return {
      ok: true,
      output: `${preview}\n... file truncated at ${maxBytes} bytes (size=${info.size} bytes) ...`,
      truncated: true,
      stats: { bytesRead: info.size, bytesShown: bytesRead, bytesDropped: Math.max(0, info.size - bytesRead) },
    };
  } finally {
    await handle.close();
  }
}

export async function fsWrite(
  path: string,
  content: string,
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path);
  await writeFile(resolved, content, "utf8");
  return { ok: true, output: `Wrote ${resolved}` };
}

export async function fsList(path: string): Promise<ToolResult> {
  const resolved = ensureReadAllowed(path);
  const entries = await readdir(resolved, { withFileTypes: true });
  const maxEntries = 500;
  const shown = entries.slice(0, maxEntries);
  return {
    ok: true,
    output: shown
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
      .join("\n") +
      (entries.length > maxEntries
        ? `\n... ${entries.length - maxEntries} entries omitted ...`
        : ""),
    truncated: entries.length > maxEntries,
    stats: { linesRead: entries.length },
  };
}

export async function fsSearch(
  pattern: string,
  path = process.cwd(),
): Promise<ToolResult> {
  const resolved = ensureReadAllowed(path);
  const maxLines = 200;
  const formatResult = (all: string | undefined, exitCode: number): ToolResult => {
    const lines = redactSecrets(all ?? "")
      .split(/\r?\n/)
      .filter(Boolean);
    const shown = lines.slice(0, maxLines);
    return {
      ok: exitCode === 0,
      output: shown.join("\n") +
        (lines.length > maxLines ? `\n... ${lines.length - maxLines} matches omitted ...` : ""),
      exitCode,
      truncated: lines.length > maxLines,
      stats: { linesRead: lines.length },
    };
  };
  try {
    const result = await execa("rg", ["--max-count", "5", "--max-filesize", "1M", "--glob", "!.git", "-l", pattern, resolved], {
      reject: false,
      all: true,
      timeout: 15_000,
    });
    return formatResult(result.all, result.exitCode ?? 1);
  } catch {
    const result = await execa("grep", ["-R", "-l", "-m", String(maxLines), pattern, resolved], {
      reject: false,
      all: true,
      timeout: 15_000,
    });
    return formatResult(result.all, result.exitCode ?? 1);
  }
}
