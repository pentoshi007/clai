#!/usr/bin/env sh
set -eu

# clai installer for macOS / Linux.
# Downloads a release binary, verifies its SHA256 against the published
# checksums file (clai-bun-<platform>-<arch>.sha256) on the release page,
# and installs it into /usr/local/bin (or $CLAI_BIN_DIR).
#
# Skip checksum verification at your own risk by exporting
# CLAI_SKIP_CHECKSUM=1, but the default is to fail closed.

repo="${CLAI_REPO:-pentoshi007/clai}"
version="${CLAI_VERSION:-latest}"
bin_dir="${CLAI_BIN_DIR:-/usr/local/bin}"
skip_checksum="${CLAI_SKIP_CHECKSUM:-0}"

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
sum_name="${name}.sha256"

if [ "$version" = "latest" ]; then
  url="https://github.com/${repo}/releases/latest/download/${name}"
  sum_url="https://github.com/${repo}/releases/latest/download/${sum_name}"
else
  url="https://github.com/${repo}/releases/download/${version}/${name}"
  sum_url="https://github.com/${repo}/releases/download/${version}/${sum_name}"
fi

tmp="$(mktemp)"
sum_tmp="$(mktemp)"

cleanup() {
  rm -f "$tmp" "$sum_tmp" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "⬇ Downloading clai for ${platform}-${arch}..."
curl -fsSL "$url" -o "$tmp"

if [ "$skip_checksum" != "1" ]; then
  echo "🔐 Verifying SHA256..."
  if ! curl -fsSL "$sum_url" -o "$sum_tmp"; then
    echo "Could not fetch ${sum_url}." >&2
    echo "Re-run with CLAI_SKIP_CHECKSUM=1 to install without verification (not recommended)." >&2
    exit 1
  fi

  expected="$(awk '{print $1}' "$sum_tmp" | head -n1)"
  if [ -z "$expected" ]; then
    echo "Empty checksum from ${sum_url}." >&2
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  else
    echo "Neither sha256sum nor shasum found; cannot verify checksum." >&2
    echo "Re-run with CLAI_SKIP_CHECKSUM=1 to bypass (not recommended)." >&2
    exit 1
  fi

  if [ "$expected" != "$actual" ]; then
    echo "Checksum mismatch!" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  echo "✓ checksum ok ($actual)"
fi

chmod +x "$tmp"

if [ -w "$bin_dir" ]; then
  mv "$tmp" "$bin_dir/clai"
else
  echo "Installing to $bin_dir (requires sudo)..."
  sudo mv "$tmp" "$bin_dir/clai"
fi

echo "✓ Installed clai to $bin_dir/clai"
echo "  Run 'clai' to get started."
