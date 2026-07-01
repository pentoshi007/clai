/**
 * Map a package name to the executable it installs, when they differ. Used
 * by pkg.install to check whether the tool already exists before installing.
 * Most packages share their binary name, so this only lists the exceptions.
 */
const PACKAGE_BINARY_ALIASES: Record<string, string> = {
  ripgrep: "rg",
  dnsutils: "dig",
  "bind-utils": "dig",
  "bind9-dnsutils": "dig",
  "python3-pip": "pip3",
  "build-essential": "gcc",
  nodejs: "node",
  golang: "go",
  "g++": "g++",
  imagemagick: "magick",
  "netcat-openbsd": "nc",
  "net-tools": "ifconfig",
  coreutils: "ls",
};

export function packageBinaryName(pkg: string): string {
  const lower = pkg.toLowerCase();
  if (PACKAGE_BINARY_ALIASES[lower]) return PACKAGE_BINARY_ALIASES[lower]!;
  // Strip a tap/cask prefix (homebrew "owner/tap/name" → "name") and any
  // version suffix (apt "pkg=1.2" → "pkg") so the binary guess is sane.
  const noTap = pkg.includes("/") ? pkg.slice(pkg.lastIndexOf("/") + 1) : pkg;
  return noTap.split(/[=@:]/)[0] ?? noTap;
}
