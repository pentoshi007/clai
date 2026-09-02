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
  const noTap = pkg.includes("/") ? pkg.slice(pkg.lastIndexOf("/") + 1) : pkg;
  return noTap.split(/[=@:]/)[0] ?? noTap;
}
