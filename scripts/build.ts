import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { execa } from "execa";
import { parseReleaseTarget, releaseTargets, targetBuildArguments, targetNativePackages } from "./release-targets.js";

const { values } = parseArgs({ options: { target: { type: "string", multiple: true }, outdir: { type: "string", default: "release" } } });
const targets = [...new Set((values.target ?? releaseTargets).map(parseReleaseTarget))];
const packages = [...new Set(targets.flatMap(targetNativePackages))];
await execa("node", ["--import", "tsx", "scripts/embed-skills.ts"], { stdio: "inherit" });
if (packages.length > 0) {
  await execa("node", ["scripts/install-opentui-platforms.mjs", ...packages], { stdio: "inherit" });
}
await mkdir(values.outdir, { recursive: true });
for (const target of targets) {
  const extension = target.includes("windows") ? ".exe" : "";
  const output = join(values.outdir, `clai-${target}${extension}`);
  console.log(`Building ${output}`);
  await execa(process.execPath, targetBuildArguments(target, output), { stdio: "inherit" });
}
