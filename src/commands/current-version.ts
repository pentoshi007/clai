import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION as GENERATED_VERSION } from "../version.generated.js";
import { releaseVersion } from "./update/verification.js";

/**
 * Version resolution order:
 * 1. package.json (dev / npm install) — always matches the checkout
 * 2. src/version.generated.ts — baked into bun --compile binaries
 *
 * Humans only edit package.json; run `npm run sync-version` (also via
 * build/pretest) to refresh the generated constant and install manifests.
 */
function resolvePackageVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      try {
        const pkg: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg && typeof pkg === "object" && "name" in pkg && pkg.name === "@pentoshi/clai" && "version" in pkg) {
          const version = releaseVersion(pkg.version);
          if (version) return version;
        }
      } catch {
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  return GENERATED_VERSION;
}

const CURRENT_VERSION = resolvePackageVersion();

export function getCurrentVersion(): string {
  return CURRENT_VERSION;
}
