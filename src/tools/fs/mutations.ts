import type { ToolResult } from "../../types.js";
import { buildFileChange, formatUnifiedPreview } from "../file-diff.js";
import type { FileChange } from "../file-diff.js";
import { writeFileAtomic } from "../fs.js";
import { ensureWriteAllowed } from "./internals.js";
import type { FileWrite } from "../fs.js";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Threshold above which whole-file mutation is refused or replaced by an
 * in-place strategy. Reading and rewriting a very large file holds 2x its size
 * in heap in a process that also carries transcript state.
 */
const LARGE_MUTATION_BYTES = 8 * 1024 * 1024;

/** Compact integrity footer so the model trusts a write without re-reading. */
export function describeWrite(
  path: string,
  content: string,
  verb: string,
): string {
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  const sha = createHash("sha256")
    .update(content, "utf8")
    .digest("hex")
    .slice(0, 12);
  const lastNonEmpty = content
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .at(-1);
  const tail = lastNonEmpty
    ? lastNonEmpty.length > 80
      ? `${lastNonEmpty.slice(0, 77)}…`
      : lastNonEmpty
    : "(empty)";
  return (
    `${verb} ${path}\n` +
    `  bytes=${bytes} lines=${lines} sha256_12=${sha}\n` +
    `  ends_with: ${JSON.stringify(tail)}\n` +
    `  Do NOT re-read this file to verify the write unless editing further — trust this receipt.`
  );
}

const WRITE_MANY_MAX_FILES = 50;

/**
 * Write several files in a single tool call. This is the workhorse for
 * scaffolding a project: a React app, an Express server, etc. all need a
 * handful of files, and forcing one fs.write per file burns through the
 * agent's step budget (the most common reason a scaffold never finished).
 *
 * Each entry is validated and written independently — a bad path does not
 * abort the whole batch. Parent directories are created automatically, just
 * like fs.write.
 */
export async function fsWriteMany(
  files: FileWrite[],
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      output:
        'fs.writeMany requires a non-empty "files" array of { path, content } objects.',
      exitCode: 1,
    };
  }
  if (files.length > WRITE_MANY_MAX_FILES) {
    return {
      ok: false,
      output: `fs.writeMany accepts at most ${WRITE_MANY_MAX_FILES} files per call (got ${files.length}). Split the scaffold into smaller batches.`,
      exitCode: 1,
    };
  }

  const written: string[] = [];
  const failures: string[] = [];
  const changes: FileChange[] = [];
  for (const file of files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      typeof file.content !== "string"
    ) {
      failures.push(
        `invalid entry — each file needs a non-empty string "path" and a string "content": ${JSON.stringify(file)}`,
      );
      continue;
    }
    try {
      const resolved = ensureWriteAllowed(file.path, options.confirmed);
      let before = "";
      let existed = false;
      try {
        before = await readFile(resolved, "utf8");
        existed = true;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, file.content, "utf8");
      const bytes = Buffer.byteLength(file.content, "utf8");
      const nLines =
        file.content.length === 0 ? 0 : file.content.split(/\r?\n/).length;
      const sha = createHash("sha256")
        .update(file.content, "utf8")
        .digest("hex")
        .slice(0, 12);
      written.push(
        `${resolved} (bytes=${bytes} lines=${nLines} sha256_12=${sha})`,
      );
      changes.push(
        buildFileChange({
          path: resolved,
          before,
          after: file.content,
          kind: existed ? "overwrite" : "create",
        }),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push(`${file.path}: ${msg}`);
    }
  }

  // Clean multi-line receipt: one path per line (UI lists basenames; pager
  // still has full paths). Avoid repeating the same dump twice in the spool.
  const lines: string[] = [];
  if (written.length > 0) {
    lines.push(`Wrote ${written.length} file(s):`);
    for (const p of written) lines.push(`  ${p}`);
  }
  if (failures.length > 0) {
    lines.push(`Failed ${failures.length} file(s):`);
    for (const f of failures) lines.push(`  ${f}`);
  }
  return {
    ok: failures.length === 0,
    output: lines.join("\n"),
    exitCode: failures.length === 0 ? 0 : 1,
    ...(changes.length > 0 ? { fileChanges: changes } : {}),
  };
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
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  const priorStat = await stat(resolved).catch(() => undefined);
  if (priorStat?.isFile() && priorStat.size > LARGE_MUTATION_BYTES) {
    return {
      ok: false,
      output:
        `fs.edit refuses ${resolved}: ${priorStat.size.toLocaleString()} bytes exceeds the ${Math.round(LARGE_MUTATION_BYTES / (1024 * 1024))}MB whole-file edit limit. ` +
        `Use fs.replaceLines for a bounded line range, or a streaming tool (sed -i / awk) via shell.exec.`,
      exitCode: 1,
    };
  }
  const content = await readFile(resolved, "utf8");
  const expected = expectedReplacements ?? 1;

  let targetOldText = oldText;
  let targetNewText = newText;

  // Count occurrences (exact match first)
  let count = 0;
  let searchPos = 0;
  while (true) {
    const idx = content.indexOf(targetOldText, searchPos);
    if (idx === -1) break;
    count += 1;
    searchPos = idx + targetOldText.length;
  }

  // Fallback: match CRLF / LF line ending differences or trailing whitespace
  if (count === 0) {
    const hasCRLF = content.includes("\r\n");
    const candidateOld = hasCRLF
      ? oldText.replace(/\r?\n/g, "\r\n")
      : oldText.replace(/\r\n/g, "\n");
    const candidateNew = hasCRLF
      ? newText.replace(/\r?\n/g, "\r\n")
      : newText.replace(/\r\n/g, "\n");

    let altCount = 0;
    let altPos = 0;
    while (true) {
      const idx = content.indexOf(candidateOld, altPos);
      if (idx === -1) break;
      altCount += 1;
      altPos = idx + candidateOld.length;
    }

    if (altCount > 0) {
      targetOldText = candidateOld;
      targetNewText = candidateNew;
      count = altCount;
    } else {
      const trimmedOld = candidateOld.trimEnd();
      if (trimmedOld.length > 0) {
        let trimCount = 0;
        let trimPos = 0;
        while (true) {
          const idx = content.indexOf(trimmedOld, trimPos);
          if (idx === -1) break;
          trimCount += 1;
          trimPos = idx + trimmedOld.length;
        }
        if (trimCount > 0) {
          targetOldText = trimmedOld;
          targetNewText = candidateNew.trimEnd();
          count = trimCount;
        }
      }
    }
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

  const updated = content.replaceAll(targetOldText, targetNewText);

  // Atomic, mode-preserving, race-safe replacement.
  await writeFileAtomic(resolved, updated);

  const change = buildFileChange({
    path: resolved,
    before: content,
    after: updated,
    kind: "edit",
  });
  const preview = formatUnifiedPreview(change, { maxLines: 24 });
  return {
    ok: true,
    output: `Replaced ${count} occurrence(s) in ${resolved}.\n${preview}`,
    fileChanges: [change],
  };
}

/**
 * Delete a file or directory. Requires the path to be inside the
 * write sandbox and not a secret path.
 */
export async function fsDelete(
  path: string,
  recursive?: boolean | undefined,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  try {
    // Snapshot text content for diff UI when deleting a single small file.
    let before = "";
    let canDiff = false;
    if (!recursive) {
      try {
        const st = await stat(resolved);
        if (st.isFile() && st.size <= 200_000) {
          before = await readFile(resolved, "utf8");
          canDiff = true;
        }
      } catch {
        /* ignore — delete may still succeed or fail below */
      }
    }
    if (recursive) {
      await rm(resolved, { recursive: true, force: false });
      return { ok: true, output: `Deleted (recursive): ${resolved}` };
    }
    await unlink(resolved);
    const change = canDiff
      ? buildFileChange({
          path: resolved,
          before,
          after: "",
          kind: "delete",
        })
      : buildFileChange({
          path: resolved,
          before: "",
          after: "",
          kind: "delete",
        });
    return {
      ok: true,
      output: `Deleted: ${resolved}`,
      fileChanges: [change],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Delete failed: ${msg}`, exitCode: 1 };
  }
}

export async function fsAppend(
  path: string,
  content: string,
  options: {
    position?: "start" | "end" | undefined;
    confirmed?: boolean | undefined;
    /**
     * Optional integrity check: expected UTF-8 byte length of the file
     * *before* this append. Prevents double-append / wrong-base corruption
     * when continuing a truncated write.
     */
    expectedPriorBytes?: number | undefined;
  } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  const position = options.position ?? "end";
  if (position !== "start" && position !== "end") {
    return {
      ok: false,
      output: `Invalid position: "${position}". Must be "start" or "end".`,
      exitCode: 1,
    };
  }

  let original = "";
  // Large-file guard: reading + rewriting a 500 MB log to append a few lines
  // holds 2x the file in heap. Above the threshold, append in place with
  // `appendFile` and say the diff was skipped for size.
  const priorStat = await stat(resolved).catch(() => undefined);
  if (
    priorStat?.isFile() &&
    priorStat.size > LARGE_MUTATION_BYTES &&
    position === "end"
  ) {
    const priorBytesLarge = priorStat.size;
    if (
      typeof options.expectedPriorBytes === "number" &&
      options.expectedPriorBytes !== priorBytesLarge
    ) {
      return {
        ok: false,
        output:
          `fs.append integrity check failed for ${resolved}: expected prior bytes=${options.expectedPriorBytes}, actual=${priorBytesLarge}. ` +
          `Do NOT append again until you reconcile (read the last ~20 lines or re-write).`,
        exitCode: 1,
      };
    }
    await appendFile(resolved, content, "utf8");
    const afterStat = await stat(resolved).catch(() => undefined);
    return {
      ok: true,
      output:
        describeWrite(resolved, content, "Appended (end) to") +
        `\n  prior_bytes=${priorBytesLarge} after_bytes=${afterStat?.size ?? priorBytesLarge + Buffer.byteLength(content, "utf8")}` +
        `\n  note: file exceeds ${Math.round(LARGE_MUTATION_BYTES / (1024 * 1024))}MB — appended in place and skipped the diff/receipt hash of the whole file.`,
    };
  }
  try {
    original = await readFile(resolved, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    if (
      typeof options.expectedPriorBytes === "number" &&
      options.expectedPriorBytes !== 0
    ) {
      return {
        ok: false,
        output: `fs.append integrity check failed: expected prior bytes=${options.expectedPriorBytes} but file does not exist.`,
        exitCode: 1,
      };
    }
    // File does not exist: create missing parent directories and write content
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
    const change = buildFileChange({
      path: resolved,
      before: "",
      after: content,
      kind: "create",
    });
    return {
      ok: true,
      output: describeWrite(resolved, content, "Created"),
      fileChanges: [change],
    };
  }

  const priorBytes = Buffer.byteLength(original, "utf8");
  if (
    typeof options.expectedPriorBytes === "number" &&
    options.expectedPriorBytes !== priorBytes
  ) {
    return {
      ok: false,
      output:
        `fs.append integrity check failed for ${resolved}: expected prior bytes=${options.expectedPriorBytes}, actual=${priorBytes}. ` +
        `Do NOT append again until you reconcile (read the last ~20 lines or re-write).`,
      exitCode: 1,
    };
  }

  let next = "";
  if (position === "start") {
    next = content + original;
  } else {
    next = original + content;
  }

  // Atomic, mode-preserving, race-safe replacement.
  await writeFileAtomic(resolved, next);

  const st = await stat(resolved).catch(() => undefined);
  const change = buildFileChange({
    path: resolved,
    before: original,
    after: next,
    kind: "append",
  });
  return {
    ok: true,
    output:
      describeWrite(resolved, next, `Appended (${position}) to`) +
      `\n  prior_bytes=${priorBytes} after_bytes=${st?.size ?? Buffer.byteLength(next, "utf8")}`,
    fileChanges: [change],
  };
}
