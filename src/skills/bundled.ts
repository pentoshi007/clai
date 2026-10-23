import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getDataDir } from "../store/paths.js";
import { BUNDLED_SKILLS } from "./bundled-catalog.generated.js";
import type { SkillMeta, SkillRoot } from "./types.js";

const materializing = new Map<string, Promise<void>>();

export function bundledSkillRoot(): SkillRoot {
  return { path: join(resolve(getDataDir()), "bundled-skills"), tool: "clai", scope: "bundled" };
}

export function bundledSkillMetas(): SkillMeta[] {
  const root = bundledSkillRoot();
  return BUNDLED_SKILLS.map((skill) => {
    const dir = join(root.path, skill.name, skill.digest);
    return {
      name: skill.name,
      description: skill.description,
      dir,
      file: join(dir, "SKILL.md"),
      scope: root.scope,
      tool: root.tool,
      root: root.path,
      ...(skill.license ? { license: skill.license } : {}),
      ...(skill.compatibility ? { compatibility: skill.compatibility } : {}),
    };
  });
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function integrityError(dir: string, path: string): Error {
  return new Error(`Bundled skill cache failed integrity check at ${path}. Remove only ${dir} and retry skill.load.`);
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error(`Bundled skill cache directory must not be linked: ${path}`);
}

async function verifyTree(dir: string, files: Readonly<Record<string, string>>, prefix = ""): Promise<void> {
  const current = join(dir, prefix);
  const expected = new Set(Object.keys(files).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]!));
  const entries = await readdir(current, { withFileTypes: true });
  if (entries.length !== expected.size) throw integrityError(dir, current);
  for (const entry of entries) {
    const path = `${prefix}${entry.name}`;
    if (!expected.has(entry.name)) throw integrityError(dir, path);
    const content = files[path];
    if (content === undefined) {
      if (!entry.isDirectory()) throw integrityError(dir, path);
      await verifyTree(dir, files, `${path}/`);
      continue;
    }
    const absolute = join(dir, path);
    if (!entry.isFile() || (await lstat(absolute)).size !== Buffer.byteLength(content)) throw integrityError(dir, absolute);
    if (await readFile(absolute, "utf8") !== content) throw integrityError(dir, absolute);
  }
}

async function verifyExisting(dir: string, files: Readonly<Record<string, string>>): Promise<boolean> {
  const info = await lstat(dir).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (!info) return false;
  if (!info.isDirectory()) throw integrityError(dir, dir);
  await verifyTree(dir, files);
  return true;
}

async function materialize(meta: SkillMeta): Promise<void> {
  const { BUNDLED_SKILL_FILES } = await import("./bundled-content.generated.js");
  const files = BUNDLED_SKILL_FILES[meta.name];
  const expected = bundledSkillMetas().find((skill) => skill.name === meta.name);
  if (!files || !expected || expected.dir !== meta.dir) throw new Error(`Unknown bundled skill location: ${meta.name}`);
  await ensureDirectory(meta.root);
  await ensureDirectory(dirname(meta.dir));
  if (await verifyExisting(meta.dir, files)) return;
  const staging = await mkdtemp(join(dirname(meta.dir), ".stage-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(staging, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    try {
      await rename(staging, meta.dir);
    } catch (error) {
      if (!(await verifyExisting(meta.dir, files))) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function materializeBundledSkill(meta: SkillMeta): Promise<void> {
  const pending = materializing.get(meta.dir);
  if (pending) return pending;
  const work = materialize(meta).finally(() => materializing.delete(meta.dir));
  materializing.set(meta.dir, work);
  return work;
}
