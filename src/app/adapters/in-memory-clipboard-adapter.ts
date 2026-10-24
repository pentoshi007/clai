import { execa } from "execa";
import type { ClipboardPort } from "../ports/clipboard-port.js";

export interface InMemoryClipboard extends ClipboardPort {
  readonly lastText: string | undefined;
}

export function createInMemoryClipboardPort(): InMemoryClipboard {
  let last: string | undefined;
  return {
    get lastText() {
      return last;
    },
    async writeText(text: string) {
      last = text;
    },
    async readText() {
      return last;
    },
  };
}

export function createSystemClipboardPort(): InMemoryClipboard {
  let last: string | undefined;

  async function writeSystem(text: string): Promise<void> {
    const platform = process.platform;
    let attempts: Array<[string, string[]]> = [];
    if (platform === "darwin") {
      attempts = [["pbcopy", []]];
    } else if (platform === "linux") {
      attempts = [
        ["wl-copy", []],
        ["xclip", ["-selection", "clipboard"]],
        ["xsel", ["--clipboard", "--input"]],
      ];
    } else if (platform === "win32") {
      attempts = [["clip", []]];
    }

    for (const [cmd, args] of attempts) {
      try {
        await execa(cmd, args, {
          input: text,
          timeout: 2000,
          stdio: ["pipe", "ignore", "ignore"],
          windowsHide: true,
        });
        return;
      } catch {
        continue;
      }
    }
  }

  async function readSystem(): Promise<string | undefined> {
    const platform = process.platform;
    let attempts: Array<[string, string[]]> = [];
    if (platform === "darwin") {
      attempts = [["pbpaste", []]];
    } else if (platform === "linux") {
      attempts = [
        ["wl-paste", ["--no-newline", "--type", "text"]],
        ["xclip", ["-selection", "clipboard", "-o", "-target", "UTF8_STRING"]],
        ["xsel", ["--clipboard", "--output"]],
      ];
    } else if (platform === "win32") {
      attempts = [["powershell", ["-command", "Get-Clipboard"]]];
    }

    let readerAvailable = false;
    for (const [cmd, args] of attempts) {
      try {
        const result = await execa(cmd, args, {
          timeout: 2000,
          encoding: "utf8",
          stripFinalNewline: false,
          maxBuffer: 1_048_576,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        return result.stdout;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          readerAvailable = true;
        }
      }
    }
    return readerAvailable ? "" : undefined;
  }

  return {
    get lastText() {
      return last;
    },
    async writeText(text: string) {
      last = text;
      await writeSystem(text);
    },
    async readText() {
      const sysText = await readSystem();
      if (sysText !== undefined) {
        last = sysText;
        return sysText;
      }
      return last;
    },
  };
}
