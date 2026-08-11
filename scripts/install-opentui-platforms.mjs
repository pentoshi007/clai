#!/usr/bin/env node
/**
 * Force-install every @opentui/core-* platform package so Bun can
 * cross-compile (`bun build --compile --target …`) on a single host.
 *
 * npm skips packages whose package.json `os`/`cpu` fields do not match the
 * runner (e.g. darwin-arm64 on ubuntu-latest). Even `npm install --force`
 * still omits non-host platforms, and `npm install --os=… --cpu=…` replaces
 * previously installed platforms. So we `npm pack` each tarball and extract
 * it into node_modules ourselves.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const platforms = [
  "@opentui/core-darwin-x64",
  "@opentui/core-darwin-arm64",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-win32-x64",
  "@opentui/core-win32-arm64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-linux-arm64-musl",
];

function versionOf(name) {
  return (
    pkg.optionalDependencies?.[name] ??
    pkg.dependencies?.[name] ??
    pkg.devDependencies?.[name] ??
    pkg.dependencies?.["@opentui/core"]
  );
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    ...opts,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${result.status}): ${err}`,
    );
  }
  return result;
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const specs = platforms.map((name) => {
  const ver = versionOf(name);
  if (!ver) {
    console.error(`Missing version for ${name} in package.json`);
    process.exit(1);
  }
  return { name, ver, spec: `${name}@${ver}` };
});

console.log("Force-installing OpenTUI platform packages for cross-compile:");
for (const s of specs) console.log(`  ${s.spec}`);

const work = mkdtempSync(join(tmpdir(), "opentui-platforms-"));

try {
  for (const { name, spec } of specs) {
    const dest = join(root, "node_modules", ...name.split("/"));
    console.log(`Packing ${spec}…`);

    const before = new Set(readdirSync(work));
    run(npm, ["pack", spec, "--pack-destination", work], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const after = readdirSync(work).filter((f) => !before.has(f) && f.endsWith(".tgz"));
    if (after.length !== 1) {
      throw new Error(
        `Expected one new tarball for ${spec}, found: ${after.join(", ") || "(none)"}`,
      );
    }
    const tgzPath = join(work, after[0]);

    const extractDir = join(work, name.replaceAll("/", "-"));
    mkdirSync(extractDir, { recursive: true });
    // Windows 10+, macOS, and Linux all ship a tar that understands -xzf.
    run("tar", ["-xzf", tgzPath, "-C", extractDir]);
    const pkgDir = join(extractDir, "package");
    if (!existsSync(pkgDir)) {
      throw new Error(`Expected package/ inside ${after[0]}`);
    }

    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(pkgDir, dest, { recursive: true });
    console.log(`  → ${dest}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

rmSync(work, { recursive: true, force: true });

let missing = 0;
for (const name of platforms) {
  const dir = join(root, "node_modules", ...name.split("/"));
  if (!existsSync(dir)) {
    console.error(`Missing after install: ${dir}`);
    missing += 1;
  }
}
if (missing > 0) {
  console.error(
    `Failed to materialize ${missing} OpenTUI platform package(s). Cross-compile will fail.`,
  );
  process.exit(1);
}

console.log("All OpenTUI platform packages present.");
