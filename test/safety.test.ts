import { describe, expect, it } from "vitest";
import { classifyToolCall, isPrivateIpv4 } from "../src/safety/classifier.js";
import {
  isSecretPath,
  containsShellMetacharacter,
} from "../src/safety/patterns.js";
import { resolve } from "node:path";
import { homedir } from "node:os";

describe("safety classifier", () => {
  it("allows private IPv4 targets", () => {
    expect(isPrivateIpv4("192.168.1.10")).toBe(true);
    expect(isPrivateIpv4("10.0.0.1/24")).toBe(true);
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
  });

  it("blocks destructive shell commands", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "rm -rf /" },
    });
    expect(result.level).toBe("block");
  });

  it("auto-approves read-only shell commands", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "ls -la" },
    });
    expect(result.level).toBe("safe");
  });

  it("requires confirmation for mutating shell commands", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "mv file.txt /tmp/" },
    });
    expect(result.level).toBe("confirm");
  });

  it("auto-approves public scans without a y/n prompt", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "nmap 8.8.8.8" },
    });
    expect(result.level).toBe("safe");
  });

  it("auto-approves pentest scan tools against private targets", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: {
        command:
          "gobuster dir -u http://192.168.1.1 -w /usr/share/wordlists/common.txt",
      },
    });
    expect(result.level).toBe("safe");
  });

  it("auto-approves ffuf", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "ffuf -u http://192.168.1.1/FUZZ -w wordlist.txt" },
    });
    expect(result.level).toBe("safe");
  });
});

describe("phase 1 — secret-leak hardening", () => {
  it("isSecretPath hard-gate is disabled (always false) for pentest freeness", () => {
    // Paths that used to be blocked must never hard-block the agent.
    expect(isSecretPath(resolve(homedir(), ".ssh/id_rsa"))).toBe(false);
    expect(isSecretPath(resolve(homedir(), ".clai/keys.json"))).toBe(false);
    expect(isSecretPath(resolve(homedir(), ".aws/credentials"))).toBe(false);
    expect(isSecretPath(resolve("/Users/x/project/.env"))).toBe(false);
    expect(isSecretPath("/etc/shadow")).toBe(false);
    expect(isSecretPath(resolve("/Users/x/project/package.json"))).toBe(false);
  });

  it("containsShellMetacharacter flags pipes, &&, redirects, sudo, command subst", () => {
    expect(containsShellMetacharacter("ls | tee /tmp/x")).toBe(true);
    expect(containsShellMetacharacter("echo hi && rm bad")).toBe(true);
    expect(containsShellMetacharacter("echo hi || true")).toBe(true);
    expect(containsShellMetacharacter("cat > out.txt")).toBe(true);
    expect(containsShellMetacharacter("cat < in.txt")).toBe(true);
    expect(containsShellMetacharacter("sudo apt update")).toBe(true);
    expect(containsShellMetacharacter("echo `whoami`")).toBe(true);
    expect(containsShellMetacharacter("echo $(whoami)")).toBe(true);
    // Negative
    expect(containsShellMetacharacter("ls -la")).toBe(false);
    expect(containsShellMetacharacter("git status")).toBe(false);
  });

  it("allows shell reads of paths that used to be secret-gated (pentest)", () => {
    for (const command of [
      "cat ~/.clai/keys.json",
      "cat ~/.ssh/id_rsa",
      "cat ./project/.env",
    ]) {
      const result = classifyToolCall({
        name: "shell.exec",
        args: { command },
      });
      // Not block — may be safe or confirm depending on metacharacters.
      expect(result.level).not.toBe("block");
    }
  });

  it("does not treat remote URL paths as local secret paths", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: {
        command:
          'curl -s "https://example.com/.env" -w "\\nHTTP_CODE:%{http_code}\\n"',
      },
    });
    expect(result.level).toBe("safe");
  });

  it("does not hard-block .env when mixed with a URL (metachar may still confirm)", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: {
        command: 'curl -s "https://example.com/health" && cat ./project/.env',
      },
    });
    expect(result.level).not.toBe("block");
  });

  it("allows fs.read for paths that used to be secret-gated", () => {
    expect(
      classifyToolCall({
        name: "fs.read",
        args: { path: "~/.clai/keys.json" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "fs.read",
        args: { path: "~/.ssh/id_rsa" },
      }).level,
    ).toBe("safe");
  });

  it("still allows fs.read for ordinary project files", () => {
    const result = classifyToolCall({
      name: "fs.read",
      args: { path: "./package.json" },
    });
    expect(result.level).toBe("safe");
  });

  it("always confirms fs.delete (never auto, never block as secret)", () => {
    const result = classifyToolCall({
      name: "fs.delete",
      args: { path: "./tsconfig.node.json" },
    });
    expect(result.level).toBe("confirm");
  });

  it("confirms env (mutating? no — now auto-safe under non-mutating policy)", () => {
    // env / printenv only READ the environment; under the "confirm only for
    // mutating/installing/deleting/etc." policy they auto-execute.
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "env" } }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "printenv" } })
        .level,
    ).toBe("safe");
  });

  it("auto-runs a plain file read (cat) — reading is not mutating", () => {
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "cat /tmp/notes" },
      }).level,
    ).toBe("safe");
  });

  it("allows git status/log/diff/show as subcommand-safe", () => {
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "git status" } })
        .level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "git log -n 5" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "git diff HEAD" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "git show abc" },
      }).level,
    ).toBe("safe");
  });

  it("confirms git push / git clean / git reset --hard", () => {
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "git push origin main" },
      }).level,
    ).toBe("confirm");
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "git clean -fdx" },
      }).level,
    ).toBe("confirm");
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "git reset --hard" },
      }).level,
    ).toBe("confirm");
  });

  it("allows npm view / list, confirms npm install / publish", () => {
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "npm view react" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "npm list" } })
        .level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "npm install react" },
      }).level,
    ).toBe("confirm");
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "npm publish" } })
        .level,
    ).toBe("confirm");
  });

  it("allows pip show/list, confirms pip install", () => {
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "pip show requests" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "pip list" } })
        .level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "pip install requests" },
      }).level,
    ).toBe("confirm");
  });

  it("confirms disk-mutating commands and sensitive redirects, allows ordinary output capture", () => {
    // tee writes a file via a mutating base → confirm
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "ls | tee /tmp/x" },
      }).level,
    ).toBe("confirm");
    // chaining two read-only commands is benign → safe
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "ls && pwd" } })
        .level,
    ).toBe("safe");
    // ordinary output capture into a temp/working file is benign → safe
    // (only modify/delete/install and sensitive-path writes prompt)
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "echo hi > /tmp/y" },
      }).level,
    ).toBe("safe");
    // but redirecting into a system path is sensitive → confirm
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "echo hi > /etc/motd" },
      }).level,
    ).toBe("confirm");
  });

  it("auto-runs read-only pipelines (grep | sort | head)", () => {
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "grep foo bar.txt | sort | head" },
      }).level,
    ).toBe("safe");
  });

  it("confirms file-mutating base commands (mv/cp/rm/mkdir/chmod)", () => {
    for (const command of [
      "mv a b",
      "cp a b",
      "rm a.txt",
      "mkdir newdir",
      "chmod 644 a.txt",
      "touch a.txt",
    ]) {
      expect(
        classifyToolCall({ name: "shell.exec", args: { command } }).level,
      ).toBe("confirm");
    }
  });

  it("confirms sudo", () => {
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "sudo apt update" },
      }).level,
    ).toBe("confirm");
  });

  it("classifies http.fetch methods as safe network requests", () => {
    expect(
      classifyToolCall({
        name: "http.fetch",
        args: { url: "https://example.com" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "http.fetch",
        args: { url: "https://example.com", method: "GET" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "http.fetch",
        args: { url: "https://example.com", method: "HEAD" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "http.fetch",
        args: { url: "https://example.com", method: "POST" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "http.fetch",
        args: { url: "https://example.com", method: "PUT" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "http.fetch",
        args: { url: "https://example.com", method: "DELETE" },
      }).level,
    ).toBe("safe");
  });

  it("confirms fs.write even to former secret paths (no hard block)", () => {
    const result = classifyToolCall({
      name: "fs.write",
      args: { path: "~/.ssh/authorized_keys", content: "x" },
    });
    expect(result.level).toBe("confirm");
  });

  it("classifies pdf.read as safe including former secret paths", () => {
    expect(
      classifyToolCall({
        name: "pdf.read",
        args: { path: "/tmp/report.pdf" },
      }).level,
    ).toBe("safe");
    expect(
      classifyToolCall({
        name: "pdf.read",
        args: { path: "~/.ssh/id_rsa" },
      }).level,
    ).toBe("safe");
  });

  it("auto-approves shell.exec (read-only local lookup)", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { query: "common.txt" },
    });
    expect(result.level).toBe("safe");
  });
});
