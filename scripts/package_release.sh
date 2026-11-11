#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/siyuan-plugin"
RELEASE_DIR="$ROOT_DIR/release"

echo "=== [1/4] Building & minifying Browser Companion (Terser AST) ==="
node "$ROOT_DIR/browser-companion/scripts/build.js"

echo "=== [2/4] Cleaning OS leftovers & verifying no private keys in plugin ==="
find "$PLUGIN_DIR" -name ".DS_Store" -delete || true
find "$PLUGIN_DIR" -name "*.tmp" -delete || true
if find "$PLUGIN_DIR" -name "*.pem" | grep -q .; then
  echo "❌ FATAL: Found .pem key inside siyuan-plugin! Aborting!"
  exit 1
fi

echo "=== [3/4] Packaging SiYuan Bazaar compliant release/package.zip ==="
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

python3 - "$PLUGIN_DIR" "$RELEASE_DIR/package.zip" <<'PY'
import os, sys, zipfile

src_dir = sys.argv[1]
out_zip = sys.argv[2]

with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for root, dirs, files in os.walk(src_dir, followlinks=False):
        dirs[:] = sorted([d for d in dirs if not d.startswith(".") and d != "modules"])
        for fname in sorted(files):
            if fname.startswith(".") or fname.endswith(".tmp") or fname.endswith(".pem"):
                continue
            full_path = os.path.join(root, fname)
            if os.path.islink(full_path):
                continue
            rel_path = os.path.relpath(full_path, src_dir).replace(os.sep, "/")
            zf.write(full_path, rel_path)

print(f"✔ Packaged {out_zip} ({os.path.getsize(out_zip) / 1024:.1f} KB)")
PY

cp "$RELEASE_DIR/package.zip" "$RELEASE_DIR/siyuan-metrix-v2.0.0.zip"
cp "$ROOT_DIR/browser-companion/dist/metrix-companion.zip" "$RELEASE_DIR/metrix-companion-v2.0.0.zip"

echo "=== [4/4] Release artifacts ready in $RELEASE_DIR ==="
ls -lh "$RELEASE_DIR"
