#!/usr/bin/env bash
# Build the Rust simulation core to WebAssembly and drop the bindings into the web app.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE="${PROFILE:-release}"
OUT="web/src/sim/pkg"

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "wasm-bindgen CLI not found (cargo install wasm-bindgen-cli --version 0.2.128)" >&2
  exit 1
fi

echo "==> cargo build ($PROFILE, wasm32-unknown-unknown)"
if [ "$PROFILE" = "release" ]; then
  cargo build --release --target wasm32-unknown-unknown -p rf-core
  WASM="target/wasm32-unknown-unknown/release/rf_core.wasm"
else
  cargo build --target wasm32-unknown-unknown -p rf-core
  WASM="target/wasm32-unknown-unknown/debug/rf_core.wasm"
fi

echo "==> wasm-bindgen"
mkdir -p "$OUT"
wasm-bindgen --target web --out-dir "$OUT" --out-name rf_core "$WASM"

# Ship a brotli/gzip friendly size report so regressions are visible.
SIZE=$(stat -c %s "$OUT/rf_core_bg.wasm")
echo "==> rf_core_bg.wasm: $((SIZE / 1024)) KiB"
