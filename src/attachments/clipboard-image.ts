import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { platform } from "node:os";
import { join } from "node:path";
import { safeCwd } from "../os/cwd.js";
import { scratchDirFor } from "../prompts/index.js";
import {
  detectModelImageMediaType,
  formatByteSize,
} from "./image-content.js";

export type ClipboardImageCapture =
  | {
      readonly ok: true;
      readonly path: string;
      readonly mediaType: "image/png";
      readonly byteLength: number;
    }
  | { readonly ok: false; readonly reason: string };

const CAPTURE_TIMEOUT_MS = 4_000;
const MAX_CAPTURE_BYTES = 67_108_864;
const MAX_CAPTURE_BUFFER = MAX_CAPTURE_BYTES + 1;

const execute = promisify(execFile);
const exists = (path: string): Promise<boolean> => stat(path).then((info) => info.isFile(), () => false);

async function captureCommand(command: string, args: string[]): Promise<Buffer | undefined> {
  try {
    const { stdout } = await execute(command, args, {
      encoding: "buffer",
      maxBuffer: MAX_CAPTURE_BUFFER,
      timeout: CAPTURE_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.length > 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
}

async function captureLinuxPng(): Promise<Buffer | undefined> {
  const attempts: Array<[string, string[]]> = [
    ["wl-paste", ["--no-newline", "--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ];
  for (const [command, args] of attempts) {
    const bytes = await captureCommand(command, args);
    if (bytes && detectModelImageMediaType(bytes) === "image/png") return bytes;
  }
  return undefined;
}

async function writeMacClipboardFormat(
  destination: string,
  clipboardClass: "PNGf" | "TIFF",
): Promise<boolean> {
  const script = [
    "on run argv",
    "set destinationPath to item 1 of argv",
    "try",
    `set imageData to the clipboard as «class ${clipboardClass}»`,
    "on error",
    "return \"NO_IMAGE\"",
    "end try",
    "set destinationFile to open for access POSIX file destinationPath with write permission",
    "try",
    "set eof destinationFile to 0",
    "write imageData to destinationFile",
    "close access destinationFile",
    "on error errorMessage",
    "try",
    "close access destinationFile",
    "end try",
    "error errorMessage",
    "end try",
    "return destinationPath",
    "end run",
  ].join("\n");
  try {
    const { stdout } = await execute("osascript", ["-e", script, destination], {
      encoding: "utf8",
      timeout: CAPTURE_TIMEOUT_MS,
      maxBuffer: 4096,
    });
    return stdout.trim() !== "NO_IMAGE" && await exists(destination);
  } catch {
    return false;
  }
}

async function captureMacPng(destination: string): Promise<boolean> {
  if (await writeMacClipboardFormat(destination, "PNGf")) return true;
  const tiffPath = `${destination}.tiff`;
  try {
    if (!(await writeMacClipboardFormat(tiffPath, "TIFF"))) return false;
    await execute("sips", ["-s", "format", "png", tiffPath, "--out", destination], {
      timeout: CAPTURE_TIMEOUT_MS,
      maxBuffer: 4096,
    });
    return await exists(destination);
  } catch {
    return false;
  } finally {
    await rm(tiffPath, { force: true });
  }
}

async function captureWindowsPng(destination: string): Promise<boolean> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$image = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($null -eq $image) { exit 3 }",
    "$image.Save($env:CLAI_CLIPBOARD_IMAGE_PATH, [System.Drawing.Imaging.ImageFormat]::Png)",
    "$image.Dispose()",
  ].join("; ");
  for (const command of ["powershell.exe", "pwsh.exe", "pwsh"]) {
    try {
      await execute(command, ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
        env: { ...process.env, CLAI_CLIPBOARD_IMAGE_PATH: destination },
        timeout: CAPTURE_TIMEOUT_MS,
        maxBuffer: 4096,
        windowsHide: true,
      });
      if (await exists(destination)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function validateCapturedPng(destination: string): Promise<ClipboardImageCapture> {
  try {
    const info = await stat(destination);
    if (info.size === 0) {
      return { ok: false, reason: "The clipboard does not contain an image." };
    }
    if (info.size > MAX_CAPTURE_BYTES) {
      return {
        ok: false,
        reason: `Clipboard image is ${formatByteSize(info.size)}, above the ${formatByteSize(MAX_CAPTURE_BYTES)} capture ceiling.`,
      };
    }
    const handle = await open(destination, "r");
    const bytes = Buffer.alloc(64);
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(bytes, 0, bytes.length, 0));
    } finally {
      await handle.close();
    }
    if (detectModelImageMediaType(bytes.subarray(0, bytesRead)) !== "image/png") {
      return {
        ok: false,
        reason: "Clipboard image could not be converted to PNG.",
      };
    }
    return {
      ok: true,
      path: destination,
      mediaType: "image/png",
      byteLength: info.size,
    };
  } catch {
    return { ok: false, reason: "Clipboard image could not be read." };
  }
}

export async function captureClipboardImage(
  baseDir: string = safeCwd(),
): Promise<ClipboardImageCapture> {
  const attachmentDir = join(scratchDirFor(baseDir), "attachments");
  const destination = join(
    attachmentDir,
    `clipboard-${Date.now()}-${randomUUID().slice(0, 8)}.png`,
  );
  try {
    await mkdir(attachmentDir, { recursive: true });
  } catch {
    return { ok: false, reason: "Could not create the attachment directory." };
  }

  let captured = false;
  const os = platform();
  if (os === "darwin") {
    captured = await captureMacPng(destination);
  } else if (os === "linux") {
    const bytes = await captureLinuxPng();
    if (bytes) {
      try {
        await writeFile(destination, bytes, { mode: 0o600 });
        captured = true;
      } catch {
        captured = false;
      }
    }
  } else if (os === "win32") {
    captured = await captureWindowsPng(destination);
  }

  if (!captured) {
    await rm(destination, { force: true });
    return {
      ok: false,
      reason:
        os === "linux"
          ? "Clipboard has no PNG image, or wl-paste/xclip is unavailable."
          : os === "darwin" || os === "win32"
            ? "The clipboard does not contain a supported image."
            : `Image clipboard paste is not supported on ${os}.`,
    };
  }

  const result = await validateCapturedPng(destination);
  if (!result.ok) await rm(destination, { force: true });
  return result;
}
