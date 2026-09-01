// Tests for the elevated-privileges / interactive-stdin detection used
// by `shell.exec` and `spawnArgv`. The pure helper {@link looksInteractiveStdin}
// is the safety net that decides whether to inherit the parent's stdin
// so a sudo / ssh / gpg password prompt can reach the user.

import { describe, expect, it } from "vitest";
import {
  interactiveStdinKind,
  looksInteractiveStdin,
} from "../src/tools/shell.js";

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

  it("respects real non-interactive and supplied-stdin opt-outs", () => {
    expect(looksInteractiveStdin("sudo -n whoami")).toBe(false);
    expect(looksInteractiveStdin("sudo --non-interactive uptime")).toBe(false);
    expect(looksInteractiveStdin("sudo -S whoami")).toBe(true);
    expect(looksInteractiveStdin("sudo --stdin whoami")).toBe(true);
    expect(looksInteractiveStdin("echo pw | sudo -S whoami")).toBe(false);
    expect(looksInteractiveStdin("sudo -S whoami < password.txt")).toBe(false);
    expect(looksInteractiveStdin("sudo -S whoami <<< pw")).toBe(false);
    expect(looksInteractiveStdin("sudo -S whoami | cat")).toBe(true);
    expect(looksInteractiveStdin("sudo -S whoami <(echo pw)")).toBe(true);
    expect(
      looksInteractiveStdin("sudo -S whoami", { stdinSupplied: true }),
    ).toBe(false);
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

  it("keeps scanning later segments after an opted-out segment", () => {
    expect(looksInteractiveStdin("sudo -n true && sudo whoami")).toBe(true);
    expect(looksInteractiveStdin("ssh -o BatchMode=yes a && sudo whoami")).toBe(
      true,
    );
    expect(looksInteractiveStdin("sudo -n true && ls")).toBe(false);
  });
});

describe("interactiveStdinKind", () => {
  it("classifies sudo-family segments as elevate anywhere in the line", () => {
    expect(interactiveStdinKind("sudo whoami")).toBe("elevate");
    expect(interactiveStdinKind("cd /tmp && sudo nmap -sS x")).toBe("elevate");
    expect(interactiveStdinKind("echo hi | sudo tee /root/out")).toBe("elevate");
    expect(interactiveStdinKind("su -c whoami")).toBe("elevate");
    expect(interactiveStdinKind("doas pkg upgrade")).toBe("elevate");
  });

  it("classifies sudo after a background list, inside grouping, or behind a wrapper", () => {
    expect(interactiveStdinKind("echo ready & sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("(sudo -S whoami)")).toBe("elevate");
    expect(interactiveStdinKind("(sudo -S whoami) | cat")).toBe("elevate");
    expect(interactiveStdinKind("false || sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("env sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("/usr/bin/env sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("env -- sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("env FOO=bar sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("nohup sudo -S whoami")).toBe("elevate");
  });

  it("looks past wrapper options to reach the invoked command", () => {
    expect(interactiveStdinKind("stdbuf -o0 sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("stdbuf -o 0 sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("env -i sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("env -u FOO sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("env --unset FOO sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("env FOO=bar -- sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("command -p sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("time -p sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("env -i ls -la")).toBeUndefined();
    expect(interactiveStdinKind("stdbuf -o0 echo sudo -S whoami")).toBeUndefined();
  });

  it("keeps redirections and quoted arguments out of the new boundaries", () => {
    expect(interactiveStdinKind("echo sudo -S whoami")).toBeUndefined();
    expect(interactiveStdinKind("env sudo -Sn whoami")).toBeUndefined();
    expect(interactiveStdinKind("(sudo -Sn whoami)")).toBeUndefined();
    expect(interactiveStdinKind("echo pw |& sudo -S whoami")).toBeUndefined();
    expect(interactiveStdinKind("echo pw | (env sudo -S whoami)")).toBeUndefined();
    expect(interactiveStdinKind("ls &> out.txt")).toBeUndefined();
    expect(interactiveStdinKind("ls >& out.txt")).toBeUndefined();
    expect(interactiveStdinKind("sudo -S whoami 0<&3")).toBeUndefined();
    expect(interactiveStdinKind("sudo -S whoami 2>&1")).toBe("elevate");
    expect(interactiveStdinKind("ls &")).toBeUndefined();
  });

  it("classifies ssh/gpg/passwd as tty-only", () => {
    expect(interactiveStdinKind("ssh user@host")).toBe("tty");
    expect(interactiveStdinKind("gpg --decrypt x.gpg")).toBe("tty");
    expect(interactiveStdinKind("passwd")).toBe("tty");
  });

  it("prefers elevate when both kinds appear", () => {
    expect(interactiveStdinKind("ssh a && sudo ls")).toBe("elevate");
  });

  it("parses elevation options only before the invoked command", () => {
    expect(interactiveStdinKind("sudo -Sn whoami")).toBeUndefined();
    expect(interactiveStdinKind("echo pw | sudo -SH whoami")).toBeUndefined();
    expect(interactiveStdinKind("sudo -S printf -n hello")).toBe("elevate");
    expect(
      interactiveStdinKind("sudo -S echo $(cat < input.txt)"),
    ).toBe("elevate");
    expect(interactiveStdinKind("sudo -S whoami | cat")).toBe("elevate");
  });

  it("returns undefined for non-interactive commands and supplied stdin", () => {
    expect(interactiveStdinKind("ls -la")).toBeUndefined();
    expect(interactiveStdinKind("sudo -n whoami")).toBeUndefined();
    expect(interactiveStdinKind("sudo -S whoami")).toBe("elevate");
    expect(interactiveStdinKind("sudo --stdin whoami")).toBe("elevate");
    expect(interactiveStdinKind("echo pw | sudo -S whoami")).toBeUndefined();
    expect(
      interactiveStdinKind("sudo -S whoami < password.txt"),
    ).toBeUndefined();
    expect(
      interactiveStdinKind("sudo -S whoami", { stdinSupplied: true }),
    ).toBeUndefined();
    expect(
      interactiveStdinKind("ssh -o BatchMode=yes user@host uptime"),
    ).toBeUndefined();
  });
});
