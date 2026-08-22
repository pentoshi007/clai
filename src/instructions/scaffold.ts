import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  CLAI_INSTRUCTIONS_FILE,
  PROJECT_DIR_NAME,
  RECORDED_INSTRUCTIONS_FILE,
  scaffoldTargetDir,
} from "./locations.js";
import { RECORDED_INSTRUCTIONS_TEMPLATE } from "./record.js";

const CLAI_TEMPLATE = `# CLAI.md

<!--
Project instructions for clai. This file is yours: clai reads it at the start of
every turn and follows what it says, and never rewrites it.

Anything you write outside this comment applies to every clai session in this
project — coding style, commands to prefer, things to never do. Text inside the
comment is ignored, so an untouched file costs nothing.

Example:
  - Use pnpm, never npm.
  - Never add comments to code.
  - Ask before pushing to GitHub.
-->

`;

export interface ScaffoldResult {
  readonly dir: string;
  readonly created: readonly string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeIfMissing(path: string, contents: string): Promise<boolean> {
  if (await exists(path)) return false;
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export async function ensureProjectInstructionFiles(input: {
  readonly cwd: string;
  readonly projectRoot?: string | undefined;
}): Promise<ScaffoldResult | undefined> {
  const root = scaffoldTargetDir(input);
  if (!root) return undefined;
  try {
    await access(root, constants.W_OK);
  } catch {
    return undefined;
  }
  const dir = join(root, PROJECT_DIR_NAME);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return undefined;
  }
  const created: string[] = [];
  const claiFile = join(dir, CLAI_INSTRUCTIONS_FILE);
  const recordedFile = join(dir, RECORDED_INSTRUCTIONS_FILE);
  if (await writeIfMissing(claiFile, CLAI_TEMPLATE)) created.push(claiFile);
  if (await writeIfMissing(recordedFile, RECORDED_INSTRUCTIONS_TEMPLATE)) {
    created.push(recordedFile);
  }
  return { dir, created };
}
