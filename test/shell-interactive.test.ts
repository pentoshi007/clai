// Tests for the elevated-privileges / interactive-stdin detection used
// by `shell.exec` and `spawnArgv`. The pure helper {@link looksInteractiveStdin}
// is the safety net that decides whether to inherit the parent's stdin
// so a sudo / ssh / gpg password prompt can reach the user.

import { describe, expect, it } from "vitest";
import { looksInteractiveStdin } from "../src/tools/shell.js";

describe("looksInteractiveStdin", () => {
  it("flags bare sudo invocations", () => {
    expect(looksInteractiveStdin("sudo whoami")).toBe(true);
    expect(looksInteractiveStdin("/usr/bin/sudo apt update")).toBe(true);
    expect(looksInteractiveStdin("FOO=bar sudo apt install nmap")).toBe(true);
  });

  it("flags sudo embedded after a pipe or && chain", () => {
    expect(looksInteractiveStdin("ls | sudo tee /etc/hosts")).toBe(true);
    expect(looksInteractiveStdin("apt update && sudo apt install -y nmap")).toBe(true);
    expect(looksInteractiveStdin("foo; sudo systemctl restart nginx")).toBe(true);
  });

  it("respects sudo non-interactive opt-outs", () => {
    expect(looksInteractiveStdin("sudo -n whoami")).toBe(false);
    expect(looksInteractiveStdin("sudo --non-interactive uptime")).toBe(false);
    // -S means "read password from stdin" — the caller is responsible
    // for piping it; we should not steal stdin.
    expect(looksInteractiveStdin("echo pw | sudo -S whoami")).toBe(false);
  });

  it("flags other interactive elevation tools", () => {
    expect(looksInteractiveStdin("doas pkg upgrade")).toBe(true);
    expect(looksInteractiveStdin("su -c 'whoami'")).toBe(true);
    expect(looksInteractiveStdin("gsudo whoami")).toBe(true);
    expect(looksInteractiveStdin("runas /user:Admin cmd")).toBe(true);
  });

  it("flags ssh / scp / rsync that may prompt", () => {
    expect(looksInteractiveStdin("ssh user@host uptime")).toBe(true);
    expect(looksInteractiveStdin("scp file.txt user@host:/tmp/")).toBe(true);
    // BatchMode=yes is the canonical "do not prompt" opt-out.
    expect(looksInteractiveStdin("ssh -o BatchMode=yes user@host uptime")).toBe(false);
  });

  it("flags gpg/passwd which may also prompt", () => {
    expect(looksInteractiveStdin("gpg --decrypt secret.gpg")).toBe(true);
    expect(looksInteractiveStdin("passwd")).toBe(true);
  });

  it("does not flag ordinary commands", () => {
    expect(looksInteractiveStdin("ls -la")).toBe(false);
    expect(looksInteractiveStdin("nmap -sV example.com")).toBe(false);
    expect(looksInteractiveStdin("curl -s https://example.com")).toBe(false);
    expect(looksInteractiveStdin("")).toBe(false);
  });

  it("handles invalid input gracefully", () => {
    // The helper accepts any value defensively — non-string returns false.
    expect(looksInteractiveStdin(undefined as unknown as string)).toBe(false);
    expect(looksInteractiveStdin(null as unknown as string)).toBe(false);
  });
});
