import type { ToolResult } from "../../types.js";
import { fsRead } from "./read.js";
import { MAX_FS_READ_FILES, type FsReadFileInput } from "./read-input.js";
import { boundFsReadOutput, formatFsReadSection } from "./read-sections.js";

const BATCH_MAX_BYTES = 256 * 1024;
const READ_CONCURRENCY = 3;

export async function fsReadMany(
  files: readonly FsReadFileInput[],
  options: { confirmed?: boolean | undefined; signal?: AbortSignal | undefined } = {},
): Promise<ToolResult> {
  if (files.length < 1 || files.length > MAX_FS_READ_FILES) {
    return { ok: false, exitCode: 1, output: `fs.read accepts 1–${MAX_FS_READ_FILES} files per call.` };
  }
  options.signal?.throwIfAborted();
  const results: ToolResult[] = new Array(files.length);
  const maxBytes = Math.floor(BATCH_MAX_BYTES / files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      options.signal?.throwIfAborted();
      const index = next++;
      const { path, ...filters } = files[index]!;
      try {
        results[index] = await fsRead(path, {
          ...filters,
          ...options,
          maxBytes: Math.min(filters.maxBytes ?? maxBytes, maxBytes),
        });
        options.signal?.throwIfAborted();
      } catch (error) {
        options.signal?.throwIfAborted();
        results[index] = { ok: false, exitCode: 1, output: error instanceof Error ? error.message : String(error) };
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  const failed = results.filter((result) => !result.ok).length;
  const output = results.map((result, index) => formatFsReadSection({
    index: index + 1, total: files.length, path: files[index]!.path,
    ok: result.ok, body: result.output || "(empty file)",
  })).join("\n\n");
  const bounded = boundFsReadOutput(output, BATCH_MAX_BYTES);
  return {
    ok: failed === 0,
    ...(failed > 0 ? { exitCode: 1 } : {}),
    truncated: bounded !== output || results.some((result) => result.truncated),
    output: bounded,
  };
}
