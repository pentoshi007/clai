import { open, readdir, readFile, writeFile, unlink, rm, rename } from "node:fs/promises";
import { join, dirname, basename, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execa } from "execa";
import type { ToolResult } from "../types.js";
import { getConfig } from "../store/config.js";
import { isSecretPath } from "../safety/patterns.js";

const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const DEFAULT_LIST_MAX_ENTRIES = 500;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

/** Resolve path with tilde expansion. */
function resolvePath(path: string): string {
  return resolve(expandHome(path));
}

function ensureNotSecret(resolved: string): void {
  if (isSecretPath(resolved)) {
    throw new Error(
      `Refusing to access secret path: ${resolved}. Block list covers ~/.ssh, ~/.gnupg, ~/.aws, ~/.kube, ~/.docker, ~/.npmrc, ~/.pypirc, .env, ~/.clai/keys.json, id_rsa, *.pem, *.key, /etc/shadow.`,
    );
  }
}

/**
 * Decide whether a given absolute path falls inside any approved sandbox
 * root. Roots are the configured `sandboxRoots`, the current working
 * directory, and (for read operations only) optionally the user's home
 * directory.
 *
 * `mode` flips two things:
 *   - "read"  → home directory is included as an implicit root (so the
 *               agent can still inspect dotfiles by name without each one
 *               needing to be added to sandboxRoots), but the secret-path
 *               blocklist still applies on top.
 *   - "write" → home directory is NOT included unless explicitly added to
 *               sandboxRoots, so a runaway agent can't drop files all over
 *               $HOME.
 */
function pathInsideSandbox(
  resolvedPath: string,
  mode: "read" | "write",
): boolean {
  const roots = [
    ...getConfig().sandboxRoots.map((root) => resolve(expandHome(root))),
    process.cwd(),
  ];
  if (mode === "read") {
    // For reads we also accept the user's home (so dotfiles are inspectable
    // by name, modulo the secret-path blocklist) and the OS temp dir
    // (where shellExec stores its artifacts at ~/.clai/outputs and where
    // tests mkdtemp into).
    roots.push(homedir(), tmpdir());
  }
  return roots.some((root) => {
    const rel = relative(root, resolvedPath);
    return (
      rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."))
    );
  });
}

/** Throw with a useful message when a read/list/search escapes the sandbox. */
function ensureReadAllowed(resolved: string, original: string): void {
  ensureNotSecret(resolved);
  // Allow opt-out for users who deliberately want unrestricted reads.
  if (getConfig().sandboxReads === false) return;
  if (!pathInsideSandbox(resolved, "read")) {
    throw new Error(
      `Read blocked — "${original}" resolves outside the approved sandbox roots. Add the path with /cwd or sandboxRoots, or set sandboxReads=false.`,
    );
  }
}

/** Resolve + sandbox check for write operations. */
function ensureWriteAllowed(path: string): string {
  const resolved = resolvePath(path);
  ensureNotSecret(resolved);
  if (!pathInsideSandbox(resolved, "write")) {
    throw new Error(`Write blocked — path is outside approved roots: ${path}`);
  }
  return resolved;
}

export async function fsRead(
  path: string,
  options: { maxBytes?: number | undefined } = {},
): Promise<ToolResult> {
  const resolved = resolvePath(path);
  ensureReadAllowed(resolved, path);
  const maxBytes = options.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  const handle = await open(resolved, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        ok: false,
        output: `Not a regular file: ${resolved}`,
        exitCode: 1,
      };
    }
    const cap = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(cap);
    const { bytesRead } = await handle.read(buffer, 0, cap, 0);
    const truncated = stat.size > maxBytes;
    const text = buffer.slice(0, bytesRead).toString("utf8");
    const suffix = truncated
      ? `\n... (truncated at ${maxBytes.toLocaleString()} bytes of ${stat.size.toLocaleString()})`
      : "";
    return {
      ok: true,
      output: `${text}${suffix}`,
      truncated,
    };
  } finally {
    await handle.close().catch(() => undefined);
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

export async function fsList(
  path: string,
  options: { maxEntries?: number | undefined } = {},
): Promise<ToolResult> {
  const resolved = resolvePath(path);
  ensureReadAllowed(resolved, path);
  const maxEntries = options.maxEntries ?? DEFAULT_LIST_MAX_ENTRIES;
  const entries = await readdir(resolved, { withFileTypes: true });
  const truncated = entries.length > maxEntries;
  const visible = truncated ? entries.slice(0, maxEntries) : entries;
  const lines = visible.map(
    (entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`,
  );
  if (truncated) {
    lines.push(
      `... (${(entries.length - maxEntries).toLocaleString()} entries omitted of ${entries.length.toLocaleString()})`,
    );
  }
  return {
    ok: true,
    output: lines.join("\n"),
    truncated,
  };
}

export async function fsSearch(
  pattern: string,
  path = process.cwd(),
): Promise<ToolResult> {
  const resolved = resolvePath(path);
  ensureReadAllowed(resolved, path);
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

/**
 * Atomic search-and-replace edit. Reads the file, validates the match
 * count, performs replacement, and writes back.
 */
export async function fsEdit(
  path: string,
  oldText: string,
  newText: string,
  expectedReplacements?: number | undefined,
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path);
  const content = await readFile(resolved, "utf8");
  const expected = expectedReplacements ?? 1;

  // Count occurrences
  let count = 0;
  let searchPos = 0;
  while (true) {
    const idx = content.indexOf(oldText, searchPos);
    if (idx === -1) break;
    count += 1;
    searchPos = idx + oldText.length;
  }

  if (count === 0) {
    return {
      ok: false,
      output: `No matches found for the search text in ${resolved}. The text to replace was not found.`,
      exitCode: 1,
    };
  }
  if (count !== expected) {
    return {
      ok: false,
      output: `Found ${count} occurrence(s) of the search text, but expected exactly ${expected}. Aborting to avoid unintended changes. Use expectedReplacements=${count} if you want to replace all.`,
      exitCode: 1,
    };
  }

  const updated = content.replaceAll(oldText, newText);

  // Atomic write: write to temp file in same directory, then rename
  const tempPath = join(dirname(resolved), `.${basename(resolved)}.clai-tmp`);
  try {
    await writeFile(tempPath, updated, "utf8");
    await rename(tempPath, resolved);
  } catch (error) {
    // Cleanup temp file on failure
    try { await unlink(tempPath); } catch { /* ignore */ }
    throw error;
  }

  return {
    ok: true,
    output: `Replaced ${count} occurrence(s) in ${resolved}.`,
  };
}

/**
 * Delete a file or directory. Requires the path to be inside the
 * write sandbox and not a secret path.
 */
export async function fsDelete(
  path: string,
  recursive?: boolean | undefined,
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path);
  try {
    if (recursive) {
      await rm(resolved, { recursive: true, force: false });
      return { ok: true, output: `Deleted (recursive): ${resolved}` };
    }
    await unlink(resolved);
    return { ok: true, output: `Deleted: ${resolved}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Delete failed: ${msg}`, exitCode: 1 };
  }
}
