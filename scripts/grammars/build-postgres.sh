#!/usr/bin/env bash
# Rebuilds src/extraction/wasm/tree-sitter-{postgres,plpgsql}.wasm from the
# pinned upstream commit plus docs/grammars/tree-sitter-postgres.patch.
# Provenance and expected checksums: docs/grammars/tree-sitter-postgres.md.
#
# Usage: scripts/grammars/build-postgres.sh [work-dir]
# The work dir (default: a fresh temp dir) is wiped and recloned on every run.
set -euo pipefail

REPO_URL=https://github.com/gmr/tree-sitter-postgres
TAG=v1.2.4
COMMIT=9b27ba5c8700f9bf808221a0f6d17fe6515da787
CLI_VERSION=0.27.1

root=$(cd "$(dirname "$0")/../.." && pwd)
patch="$root/docs/grammars/tree-sitter-postgres.patch"
out="$root/src/extraction/wasm"
work=${1:-$(mktemp -d)}

command -v tree-sitter >/dev/null || { echo "tree-sitter CLI not found" >&2; exit 1; }
have=$(tree-sitter --version | awk '{print $2}')
if [ "$have" != "$CLI_VERSION" ]; then
  echo "warning: tree-sitter $have; the committed wasm was built with $CLI_VERSION and may differ byte-for-byte" >&2
fi

rm -rf "$work/tree-sitter-postgres"
mkdir -p "$work"
# postgres/src/parser.c is a ~97 MB Git LFS object; it is regenerated below.
GIT_LFS_SKIP_SMUDGE=1 git clone --quiet "$REPO_URL" "$work/tree-sitter-postgres"
cd "$work/tree-sitter-postgres"
git -c advice.detachedHead=false checkout --quiet "$TAG"
[ "$(git rev-parse HEAD)" = "$COMMIT" ] || { echo "$TAG is not $COMMIT" >&2; exit 1; }
git apply "$patch"

for lang in postgres plpgsql; do
  (
    cd "$lang"
    start=$SECONDS
    tree-sitter generate
    echo "$lang: generate $((SECONDS - start))s"
    tree-sitter test
    start=$SECONDS
    tree-sitter build --wasm -o "$out/tree-sitter-$lang.wasm" .
    echo "$lang: wasm build $((SECONDS - start))s"
  )
done

cd "$out"
shasum -a 256 tree-sitter-postgres.wasm tree-sitter-plpgsql.wasm
