#!/usr/bin/env sh
set -eu

repo="${CLAI_REPO:-pentoshi007/clai}"
version="${CLAI_VERSION:-latest}"
bin_dir="${CLAI_BIN_DIR:-/usr/local/bin}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
esac

case "$os" in
  darwin) platform="darwin" ;;
  linux) platform="linux" ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac

name="clai-bun-${platform}-${arch}"
url="https://github.com/${repo}/releases/${version}/download/${name}"
tmp="$(mktemp)"

echo "Downloading $url"
curl -fsSL "$url" -o "$tmp"
chmod +x "$tmp"
mkdir -p "$bin_dir"
mv "$tmp" "$bin_dir/clai"
echo "Installed clai to $bin_dir/clai"
