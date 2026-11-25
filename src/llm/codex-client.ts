import { readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { gte, valid } from "semver";

const COMPATIBLE_CLIENT_VERSION = "0.172.0";

export function installedCodexVersion(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const executable of ["codex", "codex.cmd"]) {
      try {
        const path = realpathSync(join(directory, executable));
        const roots = [
          join(dirname(path), ".."),
          join(directory, "node_modules", "@openai", "codex"),
        ];
        for (const root of roots) {
          try {
            const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
            if (metadata.name !== "@openai/codex" || typeof metadata.version !== "string") continue;
            const version = metadata.version.match(/^\d+\.\d+\.\d+/)?.[0];
            if (version && valid(version) && gte(version, COMPATIBLE_CLIENT_VERSION)) return version;
          } catch {}
        }
      } catch {}
    }
  }
  return COMPATIBLE_CLIENT_VERSION;
}
