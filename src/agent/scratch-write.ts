import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import type { ToolCall } from "../types.js";

const SCRATCH_WRITABLE_TOOLS = new Set([
  "fs.write",
  "fs.writeMany",
  "fs.edit",
  "fs.replaceLines",
  "fs.append",
  "fs.delete",
]);

function expandHomeLocal(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

export function scratchWriteTargetPaths(call: ToolCall): string[] {
  if (call.name === "fs.writeMany") {
    const files = call.args.files;
    if (!Array.isArray(files)) return [];
    const paths: string[] = [];
    for (const entry of files) {
      if (entry && typeof entry === "object" && "path" in entry) {
        const p = (entry as { path?: unknown }).path;
        if (typeof p === "string" && p.length > 0) paths.push(p);
      }
    }
    return paths;
  }
  const pathArg = call.args.path;
  if (typeof pathArg !== "string" || pathArg.length === 0) return [];
  return [pathArg];
}

export function isScratchOnlyWrite(call: ToolCall, scratchDir: string): boolean {
  if (!SCRATCH_WRITABLE_TOOLS.has(call.name)) return false;
  const paths = scratchWriteTargetPaths(call);
  if (paths.length === 0) return false;
  const resolvedScratch = resolve(scratchDir);
  return paths.every((raw) => {
    const expanded = expandHomeLocal(raw);
    const resolved = resolve(expanded);
    const rel = relative(resolvedScratch, resolved);
    return rel === "" || (!rel.startsWith("..") && rel !== "..");
  });
}
