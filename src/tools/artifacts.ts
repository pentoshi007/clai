import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";

const outputsDir = join(homedir(), ".clai", "outputs");

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function safeArtifactName(name: string): string {
  return name.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "tool-output";
}

export function newArtifactPath(name: string, extension = "txt"): string {
  return join(outputsDir, `${stamp()}-${safeArtifactName(name)}.${extension}`);
}

export async function writeArtifact(
  name: string,
  output: string,
  extension = "txt",
): Promise<string> {
  const path = newArtifactPath(name, extension);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${output}\n`, "utf8");
  return path;
}

export function createArtifactStream(
  name: string,
  extension = "txt",
): { path: string; stream: Writable; remove: () => void } {
  const path = newArtifactPath(name, extension);
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { encoding: "utf8", mode: 0o600 });
  return {
    path,
    stream,
    remove: () => {
      try {
        rmSync(path, { force: true });
      } catch {
        // Best-effort cleanup.
      }
    },
  };
}

