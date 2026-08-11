export function shouldSkipBunInstall(platform = process.platform) {
  return platform === "win32";
}
