export const releaseTargets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
  "bun-windows-arm64",
] as const;

export type ReleaseTarget = typeof releaseTargets[number];

export const nativePackages = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
] as const;

export function parseReleaseTarget(value: string): ReleaseTarget {
  const target = releaseTargets.find((candidate) => candidate === value);
  if (!target) throw new Error(`Unsupported release target: ${value}`);
  return target;
}

export function targetNativePackages(target: ReleaseTarget): readonly string[] {
  if (target.includes("windows")) return [];
  const [, platform, arch] = target.split("-");
  return [`@opentui/core-${platform}-${arch}`];
}

export function targetBuildArguments(target: ReleaseTarget, output: string): string[] {
  const [, platform, arch] = target.split("-");
  const keep = new Set(targetNativePackages(target));
  const exclude: string[] = nativePackages.filter((name) => !keep.has(name));
  if (platform === "windows") exclude.push("@opentui/core", "@opentui/react");
  return [
    "build", "./src/index.ts", "--compile", "--target", target, "--outfile", output,
    "--minify", "--define", `process.platform=${JSON.stringify(platform === "windows" ? "win32" : platform)}`,
    "--define", `process.arch=${JSON.stringify(arch)}`,
    ...exclude.flatMap((name) => ["--external", name]),
  ];
}
