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
  *) echo "Unsupported OS: $os. Use install.ps1 for Windows." >&2; exit 1 ;;
esac

name="clai-bun-${platform}-${arch}"

if [ "$version" = "latest" ]; then
  url="https://github.com/${repo}/releases/latest/download/${name}"
else
  url="https://github.com/${repo}/releases/download/${version}/${name}"
fi

tmp="$(mktemp)"

echo "⬇ Downloading clai for ${platform}-${arch}..."
curl -fsSL "$url" -o "$tmp"
chmod +x "$tmp"

if [ -w "$bin_dir" ]; then
  mv "$tmp" "$bin_dir/clai"
else
  echo "Installing to $bin_dir (requires sudo)..."
  sudo mv "$tmp" "$bin_dir/clai"
fi

echo "✓ Installed clai to $bin_dir/clai"
echo "  Run 'clai' to get started."
