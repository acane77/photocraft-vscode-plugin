#!/usr/bin/env bash
# Build the VS Code / code-server extension:  $DIST/photocraft-<version>.vsix
#
# Usage: packaging/vscode/package.sh [--skip-build]
#
# The extension hosts the existing web app (apps/photocraft-web, one .wasm from Trunk).
# It does not use the split boot package: a webview has no per-file size cap.
# Needs: trunk and the wasm32-unknown-unknown target, unless --skip-build and dist/web
# is already built; node on PATH to pack the VSIX (npx @vscode/vsce).
set -euo pipefail
# shellcheck source=../env.sh
. "$(dirname "${BASH_SOURCE[0]}")/../env.sh"
HERE="$ROOT/packaging/vscode"

if [ "${1:-}" != "--skip-build" ]; then
  command -v trunk >/dev/null || { echo "error: trunk not found (cargo install trunk --locked)" >&2; exit 1; }
  (cd "$ROOT/apps/photocraft-web" && trunk build --release)
fi

APP="$ROOT/dist/web"
[ -f "$APP/index.html" ] || { echo "error: $APP/index.html missing; run without --skip-build" >&2; exit 1; }
wasm_count=0
for wasm in "$APP"/*_bg.wasm; do
  [ -f "$wasm" ] || continue
  wasm_count=$((wasm_count + 1))
done
[ "$wasm_count" -eq 1 ] || { echo "error: expected one *_bg.wasm in $APP (found $wasm_count)" >&2; exit 1; }

command -v node >/dev/null || { echo "error: node not found (needed to pack the vsix)" >&2; exit 1; }

STAGE="$CARGO_TARGET_DIR/vscode-package"
rm -rf "$STAGE"
mkdir -p "$STAGE/media"
cp "$HERE/package.json" "$HERE/extension.js" "$HERE/host.js" "$HERE/README.md" "$HERE/.vscodeignore" "$STAGE/"
cp -a "$APP/." "$STAGE/media/"
find "$STAGE/media" -name '*.map' -delete
# The VSIX version follows the workspace, without rewriting the source manifest.
node -e '
  const fs = require("fs");
  const path = require("path");
  const dir = process.argv[1];
  const pkgPath = path.join(dir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = process.argv[2];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
' "$STAGE" "$VERSION"

mkdir -p "$DIST"
OUT="$DIST/photocraft-$VERSION.vsix"
rm -f "$OUT"
(cd "$STAGE" && npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license -o "$OUT")
echo "wrote $OUT"
echo "install: code-server --install-extension $OUT"
