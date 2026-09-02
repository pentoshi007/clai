import type { ToolResult } from "../../types.js";
import { buildFileChange, formatUnifiedPreview } from "../file-diff.js";
import type { FileChange } from "../file-diff.js";
import { withFileMutation, writeFileAtomic } from "../fs.js";
import { ensureWriteAllowed } from "./internals.js";
import type { FileWrite } from "../fs.js";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

const LARGE_MUTATION_BYTES = 8 * 1024 * 1024;

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
      const mutation = await withFileMutation(resolved, async () => {
        let before = "";
        let existed = false;
        try {
          before = await readFile(resolved, "utf8");
          existed = true;
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
        await mkdir(dirname(resolved), { recursive: true });
        await writeFileAtomic(resolved, file.content);
        return { before, existed };
      });
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
          before: mutation.before,
          after: file.content,
          kind: mutation.existed ? "overwrite" : "create",
        }),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push(`${file.path}: ${msg}`);
    }
  }

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

export async function fsEdit(
  path: string,
  oldText: string,
  newText: string,
  expectedReplacements?: number | undefined,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  return withFileMutation(resolved, async () => {
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

  let count = 0;
  let searchPos = 0;
  while (true) {
    const idx = content.indexOf(targetOldText, searchPos);
    if (idx === -1) break;
    count += 1;
    searchPos = idx + targetOldText.length;
  }

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
  });
}

export async function fsDelete(
  path: string,
  recursive?: boolean | undefined,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  return withFileMutation(resolved, async () => {
  try {
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
  });
}

function appendShrankFailure(
  path: string,
  expected: number,
  actual: number,
): ToolResult {
  return {
    ok: false,
    output:
      `fs.append integrity check failed: expected prior bytes=${expected} but the file is only ${actual}. ` +
      `It was truncated or this is the wrong path — appending would silently drop the missing content. (${path})`,
    exitCode: 1,
  };
}

function appendAlreadyApplied(
  original: string,
  content: string,
  position: "start" | "end",
): boolean {
  if (content.length === 0) return false;
  return position === "start"
    ? original.startsWith(content)
    : original.endsWith(content);
}

async function fileTailEquals(
  path: string,
  size: number,
  content: string,
): Promise<boolean> {
  const expected = Buffer.from(content, "utf8");
  if (expected.length === 0 || size < expected.length) return false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(expected.length);
    await handle.read(buffer, 0, expected.length, size - expected.length);
    return buffer.equals(expected);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function fsAppend(
  path: string,
  content: string,
  options: {
    position?: "start" | "end" | undefined;
    confirmed?: boolean | undefined;
    expectedPriorBytes?: number | undefined;
  } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  const position = options.position ?? "end";
  const expectedPriorBytes = options.expectedPriorBytes;
  if (position !== "start" && position !== "end") {
    return {
      ok: false,
      output: `Invalid position: "${position}". Must be "start" or "end".`,
      exitCode: 1,
    };
  }
  if (
    expectedPriorBytes !== undefined &&
    (!Number.isSafeInteger(expectedPriorBytes) || expectedPriorBytes < 0)
  ) {
    return {
      ok: false,
      output: "fs.append expectedPriorBytes must be a non-negative safe integer.",
      exitCode: 1,
    };
  }

  return withFileMutation(resolved, async () => {
    const priorStat = await stat(resolved).catch(() => undefined);
    if (
      priorStat?.isFile() &&
      priorStat.size > LARGE_MUTATION_BYTES &&
      position === "end"
    ) {
      const priorBytes = priorStat.size;
      if (expectedPriorBytes !== undefined && expectedPriorBytes > priorBytes) {
        return appendShrankFailure(resolved, expectedPriorBytes, priorBytes);
      }
      const stale =
        expectedPriorBytes !== undefined && expectedPriorBytes < priorBytes;
      if (stale && (await fileTailEquals(resolved, priorBytes, content))) {
        return {
          ok: true,
          output:
            describeWrite(resolved, content, "Append already applied to") +
            `\n  prior_bytes=${priorBytes} expected_prior_bytes=${expectedPriorBytes}`,
        };
      }
      await appendFile(resolved, content, "utf8");
      const afterBytes =
        (await stat(resolved).catch(() => undefined))?.size ??
        priorBytes + Buffer.byteLength(content, "utf8");
      return {
        ok: true,
        output:
          describeWrite(resolved, content, "Appended (end) to") +
          `\n  prior_bytes=${priorBytes} after_bytes=${afterBytes}` +
          (stale ? `\n  note: expectedPriorBytes=${expectedPriorBytes} was stale; appended at ${priorBytes}.` : "") +
          `\n  note: file exceeds ${Math.round(LARGE_MUTATION_BYTES / (1024 * 1024))}MB — appended in place and skipped the diff/receipt hash of the whole file.`,
      };
    }

    let original = "";
    try {
      original = await readFile(resolved, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      if (expectedPriorBytes !== undefined && expectedPriorBytes !== 0) {
        return {
          ok: false,
          output:
            `fs.append integrity check failed: expected prior bytes=${expectedPriorBytes} but file does not exist.`,
          exitCode: 1,
        };
      }
      await mkdir(dirname(resolved), { recursive: true });
      await writeFileAtomic(resolved, content);
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
    if (expectedPriorBytes !== undefined && expectedPriorBytes > priorBytes) {
      return appendShrankFailure(resolved, expectedPriorBytes, priorBytes);
    }
    const stale =
      expectedPriorBytes !== undefined && expectedPriorBytes < priorBytes;
    if (stale && appendAlreadyApplied(original, content, position)) {
      return {
        ok: true,
        output:
          describeWrite(resolved, original, "Append already applied to") +
          `\n  prior_bytes=${priorBytes} expected_prior_bytes=${expectedPriorBytes}`,
      };
    }

    const next = position === "start" ? content + original : original + content;
    await writeFileAtomic(resolved, next);
    const afterBytes = Buffer.byteLength(next, "utf8");
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
        `\n  prior_bytes=${priorBytes} after_bytes=${afterBytes}` +
        (stale
          ? `\n  note: expectedPriorBytes=${expectedPriorBytes} was stale; appended at ${priorBytes}.`
          : ""),
      fileChanges: [change],
    };
  });
}
