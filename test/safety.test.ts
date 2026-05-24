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

  it("confirms public scans and keeps scope advisory", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "nmap 8.8.8.8" },
    });
    expect(result.level).toBe("confirm");
    expect(result.reason).toMatch(/scope is optional/i);
  });

  it("requires confirmation for pentest scan tools even against private targets", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: {
        command:
          "gobuster dir -u http://192.168.1.1 -w /usr/share/wordlists/common.txt",
      },
    });
    expect(result.level).toBe("confirm");
  });

  it("requires confirmation for ffuf", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "ffuf -u http://192.168.1.1/FUZZ -w wordlist.txt" },
    });
    expect(result.level).toBe("confirm");
  });
});

describe("phase 1 — secret-leak hardening", () => {
  it("isSecretPath identifies common secret locations", () => {
    expect(isSecretPath(resolve(homedir(), ".ssh/id_rsa"))).toBe(true);
    expect(isSecretPath(resolve(homedir(), ".clai/keys.json"))).toBe(true);
    expect(isSecretPath(resolve(homedir(), ".aws/credentials"))).toBe(true);
    expect(isSecretPath(resolve("/Users/x/project/.env"))).toBe(true);
    expect(isSecretPath(resolve("/Users/x/project/cert.pem"))).toBe(true);
    expect(isSecretPath("/etc/shadow")).toBe(true);
    // Negative cases
    expect(isSecretPath(resolve("/Users/x/project/package.json"))).toBe(false);
    expect(isSecretPath(resolve("/Users/x/project/src/index.ts"))).toBe(false);
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

  it("blocks shell commands that touch ~/.clai/keys.json", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "cat ~/.clai/keys.json" },
    });
    expect(result.level).toBe("block");
  });

  it("blocks shell commands that touch ~/.ssh/id_rsa", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "cat ~/.ssh/id_rsa" },
    });
    expect(result.level).toBe("block");
  });

  it("blocks shell commands that touch .env", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "cat ./project/.env" },
    });
    expect(result.level).toBe("block");
  });

  it("blocks fs.read for ~/.clai/keys.json", () => {
    const result = classifyToolCall({
      name: "fs.read",
      args: { path: "~/.clai/keys.json" },
    });
    expect(result.level).toBe("block");
  });

  it("blocks fs.read for ~/.ssh/id_rsa", () => {
    const result = classifyToolCall({
      name: "fs.read",
      args: { path: "~/.ssh/id_rsa" },
    });
    expect(result.level).toBe("block");
  });

  it("still allows fs.read for ordinary project files", () => {
    const result = classifyToolCall({
      name: "fs.read",
      args: { path: "./package.json" },
    });
    expect(result.level).toBe("safe");
  });

  it("confirms env (was auto-safe pre-phase-1)", () => {
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "env" } }).level,
    ).toBe("confirm");
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "printenv" } })
        .level,
    ).toBe("confirm");
  });

  it("confirms cat alone (was auto-safe pre-phase-1)", () => {
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "cat /tmp/notes" },
      }).level,
    ).toBe("confirm");
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

  it("confirms compound commands with pipes/redirects/&&", () => {
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "ls | tee /tmp/x" },
      }).level,
    ).toBe("confirm");
    expect(
      classifyToolCall({ name: "shell.exec", args: { command: "ls && pwd" } })
        .level,
    ).toBe("confirm");
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "echo hi > /tmp/y" },
      }).level,
    ).toBe("confirm");
  });

  it("confirms sudo", () => {
    expect(
      classifyToolCall({
        name: "shell.exec",
        args: { command: "sudo apt update" },
      }).level,
    ).toBe("confirm");
  });

  it("classifies http.fetch GET/HEAD as safe and other methods as confirm", () => {
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
    ).toBe("confirm");
    expect(
      classifyToolCall({
        name: "http.fetch",
        args: { url: "https://example.com", method: "PUT" },
      }).level,
    ).toBe("confirm");
    expect(
      classifyToolCall({
        name: "http.fetch",
        args: { url: "https://example.com", method: "DELETE" },
      }).level,
    ).toBe("confirm");
  });

  it("blocks fs.write to a secret path", () => {
    const result = classifyToolCall({
      name: "fs.write",
      args: { path: "~/.ssh/authorized_keys", content: "x" },
    });
    expect(result.level).toBe("block");
  });
});
