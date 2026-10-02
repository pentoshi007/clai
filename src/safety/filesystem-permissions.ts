import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { parse, resolve, sep } from "node:path";
import { safeCwd } from "../os/cwd.js";
import { isOutsideActiveFolder, resolveFsToolPath } from "../tools/fs.js";
import type { ToolCall } from "../types.js";
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from "./permission-mode.js";
import { shellFilesystemEffects, type FilesystemTarget } from "./shell-filesystem-effects.js";

const writeTools = new Set(["fs.write", "fs.writeMany", "fs.edit", "fs.append", "fs.replaceLines"]);
export type FilesystemPermission = "allow" | "confirm" | undefined;

function pathsForCall(call: ToolCall): string[] {
  if (call.name !== "fs.writeMany") return typeof call.args.path === "string" ? [call.args.path] : [];
  if (!Array.isArray(call.args.files)) return [];
  return call.args.files.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("path" in entry) || typeof entry.path !== "string") return [];
    return [entry.path];
  });
}

function outsideToolPath(path: string): boolean {
  try { return isOutsideActiveFolder(resolveFsToolPath(path)); }
  catch { return true; }
}

function isMissingPathError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function walkPhysically(start: string, components: readonly string[]): string {
  let cursor = start;
  for (const component of components) {
    cursor = resolve(cursor, component);
    try { cursor = realpathSync.native(cursor); }
    catch (error) { if (!isMissingPathError(error)) throw error; }
  }
  return cursor;
}

function physicalDirectory(directory: string): string {
  const root = parse(directory).root;
  if (root) return walkPhysically(realpathSync.native(root), directory.slice(root.length).split(sep));
  return walkPhysically(physicalDirectory(safeCwd()), directory.split(sep));
}

function physicalShellPath(path: string, cwd: string): string {
  const root = parse(path).root;
  const start = root ? realpathSync.native(root) : physicalDirectory(cwd);
  return walkPhysically(start, path.slice(root.length).split(sep));
}

function outsideShellTarget(target: FilesystemTarget): boolean {
  if (target.dynamic) return true;
  let path = target.path;
  if (target.homeExpansion && path === "~") path = homedir();
  else if (target.homeExpansion && path.startsWith("~/")) path = `${homedir()}/${path.slice(2)}`;
  try { return isOutsideActiveFolder(physicalShellPath(path, target.cwd)); }
  catch { return true; }
}

function shellWorkingDirectory(call: ToolCall): string | undefined {
  try { return physicalDirectory(typeof call.args.cwd === "string" ? call.args.cwd : safeCwd()); }
  catch { return undefined; }
}

export function filesystemPermission(
  call: ToolCall, mode: PermissionMode = DEFAULT_PERMISSION_MODE,
): FilesystemPermission {
  if (writeTools.has(call.name) || call.name === "fs.delete") {
    if (mode === "full-access") return "allow";
    if (call.name === "fs.delete" && mode === "default") return "confirm";
    if (writeTools.has(call.name) && mode === "allow-all") return "allow";
    const paths = pathsForCall(call);
    return paths.length === 0 || paths.some(outsideToolPath) ? "confirm" : "allow";
  }
  if (call.name !== "shell.exec" && call.name !== "terminal.start") return undefined;
  if (mode === "full-access") return "allow";
  if (typeof call.args.command !== "string") return undefined;
  const cwd = shellWorkingDirectory(call);
  if (cwd === undefined) return "confirm";
  const effects = shellFilesystemEffects(call.args.command, cwd);
  const deleting = effects.uncertainDelete || effects.deletes.length > 0;
  if (deleting && (mode === "default" || effects.uncertainDelete || effects.deletes.some(outsideShellTarget))) return "confirm";
  if (mode === "allow-all") return deleting ? "allow" : undefined;
  const writing = effects.uncertainWrite || effects.writes.length > 0;
  if (writing && (effects.uncertainWrite || effects.writes.some(outsideShellTarget))) return "confirm";
  if ((writing || deleting) && effects.filesystemOnly) return "allow";
  return undefined;
}
