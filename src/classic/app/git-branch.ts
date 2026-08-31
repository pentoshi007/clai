import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const DETACHED_HEAD = /^[0-9a-f]{7,40}$/i;

export async function readBranchFromGitDir(
  cwd: string,
): Promise<string | undefined> {
  let dir = cwd;
  for (;;) {
    const gitPath = path.join(dir, ".git");
    let gitDir: string | undefined;
    try {
      const entry = await stat(gitPath);
      if (entry.isDirectory()) {
        gitDir = gitPath;
      } else if (entry.isFile()) {
        const content = (await readFile(gitPath, "utf8")).trim();
        const pointer = /^gitdir:\s*(.+)$/i.exec(content)?.[1]?.trim();
        if (pointer) {
          gitDir = path.isAbsolute(pointer)
            ? pointer
            : path.resolve(dir, pointer);
        }
      }
    } catch {
      gitDir = undefined;
    }
    if (gitDir) {
      try {
        const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
        const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
        if (ref) {
          return ref.startsWith("refs/heads/")
            ? ref.slice("refs/heads/".length)
            : ref;
        }
        if (DETACHED_HEAD.test(head)) return "HEAD";
      } catch {
      }
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
