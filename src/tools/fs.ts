import { readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { homedir } from "node:os";
import { execa } from "execa";
import type { ToolResult } from "../types.js";
import { getConfig } from "../store/config.js";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

/** Resolve path with tilde expansion — no sandbox check (read-only callers) */
function resolvePath(path: string): string {
  return resolve(expandHome(path));
}

/** Resolve + sandbox check for write operations only */
function ensureWriteAllowed(path: string): string {
  const resolved = resolvePath(path);
  const roots = [
    ...getConfig().sandboxRoots.map((root) => resolve(expandHome(root))),
    resolve(homedir()),
  ];
  const allowed = roots.some((root) => {
    const rel = relative(root, resolved);
    return (
      rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."))
    );
  });
  if (!allowed) {
    throw new Error(`Write blocked — path is outside approved roots: ${path}`);
  }
  return resolved;
}

export async function fsRead(path: string): Promise<ToolResult> {
  const resolved = resolvePath(path);
  const content = await readFile(resolved, "utf8");
  return { ok: true, output: content };
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
  const resolved = resolvePath(path);
  const entries = await readdir(resolved, { withFileTypes: true });
  return {
    ok: true,
    output: entries
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
      .join("\n"),
  };
}

export async function fsSearch(
  pattern: string,
  path = process.cwd(),
): Promise<ToolResult> {
  const resolved = resolvePath(path);
  const maxLines = 50;
  try {
    const result = await execa("rg", ["--max-count", "5", "--max-filesize", "1M", "-l", pattern, resolved], {
      reject: false,
      all: true,
      timeout: 15_000,
    });
    return {
      ok: result.exitCode === 0,
      output: result.all ?? "",
      exitCode: result.exitCode,
    };
  } catch {
    const result = await execa("grep", ["-R", "-l", "-m", String(maxLines), pattern, resolved], {
      reject: false,
      all: true,
      timeout: 15_000,
    });
    return {
      ok: result.exitCode === 0,
      output: result.all ?? "",
      exitCode: result.exitCode,
    };
  }
}
