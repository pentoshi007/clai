/**
 * Install every @opentui/core-* native package needed for bun --compile
 * cross-builds. npm only installs the host platform optional dep; bun still
 * resolves all platform import() paths at compile time.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

const version = pkg.dependencies?.["@opentui/core"];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(
    `package.json must pin @opentui/core to an exact version (got ${version ?? "missing"})`,
  );
}

/** Packages referenced by @opentui/core dynamic imports (see core index). */
const NATIVE_PACKAGES = [
  `@opentui/core-darwin-arm64@${version}`,
  `@opentui/core-darwin-x64@${version}`,
  `@opentui/core-linux-arm64@${version}`,
  `@opentui/core-linux-arm64-musl@${version}`,
  `@opentui/core-linux-x64@${version}`,
  `@opentui/core-linux-x64-musl@${version}`,
  `@opentui/core-win32-arm64@${version}`,
  `@opentui/core-win32-x64@${version}`,
] as const;

console.log(`Installing OpenTUI natives @${version} for cross-compile…`);
await execa(
  "npm",
  ["install", "--no-save", "--force", "--ignore-scripts", ...NATIVE_PACKAGES],
  { stdio: "inherit", cwd: root },
);
console.log("OpenTUI natives ready.");
