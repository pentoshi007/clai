import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearActiveProjectRoot, setActiveProjectRoot } from "../../src/agent/project-root.js";
import { filesystemPermission } from "../../src/safety/filesystem-permissions.js";
import { invokesDeleteCommand } from "../../src/safety/shell-command-words.js";
import type { PermissionMode } from "../../src/safety/permission-mode.js";

let base: string;
let project: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "clai-delete-detection-"));
  project = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  setActiveProjectRoot(project);
});

afterEach(() => {
  clearActiveProjectRoot();
  rmSync(base, { recursive: true, force: true });
});

function permission(command: string, mode: PermissionMode, cwd: string = project) {
  return filesystemPermission({ name: "shell.exec", args: { command, cwd } }, mode);
}

const MENTIONS_WITHOUT_DELETING = [
  "git commit -m \"fix rm handling in the farm module\"",
  "git commit -m \"rm old files\"",
  "git log --oneline --grep=\"rm \"",
  "git log --grep=rm",
  "gh pr create --title \"fix: rm false positives\" --body \"farm\"",
  "curl -s -d 'cmd=rm x' https://farm.example.com",
  "grep -rn \"rm \" src",
  "grep -rn rm src/safety",
  "rg '\\brm\\b' src",
  "ls -la | grep rm",
  "echo 'storm' | grep -c rm",
  "echo \"(rm is a command)\"",
  "echo $(date) && cat docs/rm.md",
  "cat docs/rm.md $(pwd)",
  "ls farm-rm-notes $(pwd)",
  "ls my-rm-dir && (echo ok)",
  "cat file.rm; (echo ok)",
  "ls /usr/local/share/rm",
  "which rm",
  "type rm",
  "man rm",
  "command -v rm",
  "command -V rm",
  "alias rm=x",
  "npm rm left-pad",
  "docker rm old-container",
  "docker run --rm alpine echo hi",
  "docker run --rm -v $(pwd):/app alpine ls",
  "find . -name rm -type f",
  "find . -name '*rm*' -print",
  "git ls-files | xargs grep -l rm",
  "echo x | xargs echo rm",
  "ssh farm ls",
  "farm --help",
  "make farm",
  "gcc -o farm farm.c",
  "arm-none-eabi-gcc -c main.c",
  "npm run format && npm test",
  "python3 manage.py rm legacy",
  "pip install farm-rm",
  "git rm --cached build.log",
  "git rm -n src/old.ts",
] as const;

const DELETIONS_THAT_MUST_PROMPT = [
  "rm ../outside/file.txt",
  "/bin/rm ../outside/file.txt",
  "\\rm ../outside/file.txt",
  "RM ../outside/file.txt",
  "sudo rm ../outside/file.txt",
  "sudo -n rm ../outside/file.txt",
  "sudo -u root rm ../outside/file.txt",
  "sudo -- rm ../outside/file.txt",
  "doas rm ../outside/file.txt",
  "env -i rm ../outside/file.txt",
  "env -u HOME rm ../outside/file.txt",
  "env -C ../outside rm file.txt",
  "env --chdir ../outside rm file.txt",
  "busybox rm ../outside/file.txt",
  "nice -n 5 rm ../outside/file.txt",
  "timeout 5 rm ../outside/file.txt",
  "nohup rm ../outside/file.txt",
  "command rm ../outside/file.txt",
  "FOO=1 rm ../outside/file.txt",
  "ls; rm ../outside/file.txt",
  "ls && rm ../outside/file.txt",
  "ls | rm ../outside/file.txt",
  "if true; then rm ../outside/file.txt; fi",
  "while true; do rm ../outside/file.txt; done",
  "! rm ../outside/file.txt",
  "{ rm ../outside/file.txt; }",
  "(rm ../outside/file.txt)",
  "echo $(rm ../outside/file.txt)",
  "echo `rm ../outside/file.txt`",
  "echo \"$(rm ../outside/file.txt)\"",
  "xargs rm",
  "xargs -0 -n1 rm",
  "xargs -I {} rm {}",
  "ls | xargs sudo rm",
  "find ../outside -delete",
  "find . -exec rm {} +",
  "find . -execdir rm {} \\;",
  "find . -exec sudo rm {} \\;",
  "bash -c 'rm ../outside/file.txt'",
  "sh -c \"ls && rm ../outside/file.txt\"",
  "git rm ../outside/file.txt",
  "git -C ../outside rm file.txt",
  "git --git-dir=../outside/.git rm file.txt",
  "ssh host rm file.txt",
  "ssh host 'ls; rm file.txt'",
  "docker exec web rm /tmp/cache",
  "docker compose exec web rm /tmp/cache",
  "podman run alpine rm /tmp/cache",
  "kubectl exec pod -- rm /tmp/cache",
  "python3 -c \"import os; os.system('rm ../outside/file.txt')\"",
  "node -e \"require('child_process').execSync('rm ../outside/file.txt')\"",
  "perl -e 'system(\"rm ../outside/file.txt\")'",
  "rm \"$TARGET\"",
  "rm $(cat targets)",
  "$COMMAND ../outside/file.txt",
  "eval 'rm ../outside/file.txt'",
  "printf 'rm ../outside/file.txt' | sh",
  "rmdir ../outside",
  "unlink ../outside/file.txt",
] as const;

describe("shell deletion is detected by command position, never by substring", () => {
  it.each(MENTIONS_WITHOUT_DELETING)("does not prompt in auto-allow or default mode for: %s", (command) => {
    expect(permission(command, "allow-all")).toBeUndefined();
    expect(permission(command, "default")).toBeUndefined();
  });

  it.each(DELETIONS_THAT_MUST_PROMPT)("keeps prompting in auto-allow mode for: %s", (command) => {
    expect(permission(command, "allow-all")).toBe("confirm");
  });

  it.each(DELETIONS_THAT_MUST_PROMPT)("never prompts in full-access mode for: %s", (command) => {
    expect(permission(command, "full-access")).toBe("allow");
  });

  it.each([
    "rm local.txt",
    "sudo rm local.txt",
    "if true; then rm local.txt; fi",
    "git rm local.txt",
    "find . -name '*.tmp' -delete",
  ])("allows proven local deletion in auto-allow mode and prompts in default mode for: %s", (command) => {
    expect(permission(command, "allow-all")).toBe("allow");
    expect(permission(command, "default")).toBe("confirm");
  });
});

describe("invokesDeleteCommand", () => {
  it.each([
    "rm x",
    "  rm   x",
    "ls; rm x",
    "echo ok && sudo rm x",
    "'rm x'",
    "os.system('rm x')",
    "$(rm x)",
    "ls | xargs rm",
    "find . -exec rm {} \\;",
    "if ok; then rm x; fi",
    "/usr/bin/rm x",
  ])("detects an invocation in: %s", (text) => {
    expect(invokesDeleteCommand(text)).toBe(true);
  });

  it.each([
    "farm",
    "form rm",
    "perform the rm",
    "alarm; harm",
    "docs/rm.md",
    "file.rm",
    "my-rm-dir",
    "rm-tool --help",
    "--rm",
    "echo rm",
    "grep rm file",
    "command -v rm",
    "git commit -m 'fix rm'",
    "",
  ])("does not report an invocation in: %s", (text) => {
    expect(invokesDeleteCommand(text)).toBe(false);
  });

  it("terminates on deeply nested delegation", () => {
    const nested = `${"xargs ".repeat(64)}rm`;
    expect(() => invokesDeleteCommand(nested)).not.toThrow();
  });
});

describe("quoted prose never triggers a deletion prompt", () => {
  const words = ["rm", "farm", "form", "perform", "alarm", "storm", "arm64", "rmdir", "unlink", "rm -rf", "platform", "the", "fix", "docs/rm.md", "-rm"];
  const sentence = fc
    .array(fc.constantFrom(...words), { minLength: 1, maxLength: 12 })
    .map((parts) => parts.join(" "));

  const wrappers: ReadonlyArray<(text: string) => string> = [
    (text) => `git commit -m '${text}'`,
    (text) => `gh pr create --title '${text}' --body '${text}'`,
    (text) => `grep -rn '${text}' src`,
    (text) => `curl -s -d '${text}' https://example.com`,
    (text) => `echo '${text}'`,
  ];

  it.each(["allow-all", "default"] as const)("holds for %s mode", (mode) => {
    fc.assert(
      fc.property(sentence, fc.constantFrom(...wrappers), (text, wrap) => {
        expect(permission(wrap(text), mode)).toBeUndefined();
      }),
      { numRuns: 300 },
    );
  });
});
