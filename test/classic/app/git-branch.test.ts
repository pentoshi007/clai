import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readBranchFromGitDir } from "../../../src/classic/app/git-branch.js";

let root: string | undefined;

async function base(): Promise<string> {
  root ??= await mkdtemp(path.join(tmpdir(), "clai-git-branch-"));
  return root;
}

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("readBranchFromGitDir", () => {
  it("reads the branch from .git/HEAD", async () => {
    const repo = path.join(await base(), "repo");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(await readBranchFromGitDir(repo)).toBe("main");
  });

  it("walks up from nested directories", async () => {
    const repo = path.join(await base(), "nested");
    const deep = path.join(repo, "src", "deep");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(deep, { recursive: true });
    await writeFile(
      path.join(repo, ".git", "HEAD"),
      "ref: refs/heads/feature/foo\n",
    );
    expect(await readBranchFromGitDir(deep)).toBe("feature/foo");
  });

  it("follows a worktree .git file with an absolute gitdir", async () => {
    const baseDir = await base();
    const gitDir = path.join(baseDir, "wt-gitdir");
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/wt-branch\n");
    const worktree = path.join(baseDir, "worktree");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    expect(await readBranchFromGitDir(worktree)).toBe("wt-branch");
  });

  it("resolves a relative gitdir pointer", async () => {
    const baseDir = await base();
    const repo = path.join(baseDir, "relrepo");
    const gitDir = path.join(baseDir, "rel-gitdir");
    await mkdir(repo, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/rel\n");
    await writeFile(path.join(repo, ".git"), "gitdir: ../rel-gitdir\n");
    expect(await readBranchFromGitDir(repo)).toBe("rel");
  });

  it("returns HEAD for a detached checkout", async () => {
    const repo = path.join(await base(), "detached");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await writeFile(
      path.join(repo, ".git", "HEAD"),
      "0123456789abcdef0123456789abcdef01234567\n",
    );
    expect(await readBranchFromGitDir(repo)).toBe("HEAD");
  });

  it("returns undefined outside a repository", async () => {
    const plain = path.join(await base(), "plain");
    await mkdir(plain, { recursive: true });
    expect(await readBranchFromGitDir(plain)).toBeUndefined();
  });
});
