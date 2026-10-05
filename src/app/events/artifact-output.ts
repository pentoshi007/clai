import { closeSync, openSync, readSync, statSync } from "node:fs";
import { copyString } from "../../os/copy-string.js";

const MAX_OUTPUT_CHARS = 256 * 1024;

export function readArtifactTail(path: string): string | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size <= 0) return undefined;
    const bytesToRead = Math.min(size, MAX_OUTPUT_CHARS * 4);
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, size - bytesToRead);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (size > bytesToRead) {
      const newline = text.indexOf("\n");
      if (newline >= 0) text = text.slice(newline + 1);
    }
    if (text.length > MAX_OUTPUT_CHARS) text = copyString(text.slice(-MAX_OUTPUT_CHARS));
    return text.trim().length > 0 ? copyString(text) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
