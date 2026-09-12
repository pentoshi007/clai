set -eu

cd "$(dirname "$0")/.."

npm ci --no-audit --no-fund

npm install --prefix .hoplite/toolchains/bun --no-save --package-lock=false bun@1.3.14
mkdir -p node_modules/.bin
ln -sfn ../../.hoplite/toolchains/bun/node_modules/.bin/bun node_modules/.bin/bun
node_modules/.bin/bun --version
