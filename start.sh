#!/usr/bin/env bash
# One command from a fresh clone to a running game: compile the Rust sim to wasm32,
# make sure web dependencies match the lockfile, then start vite on all interfaces.
# `--frozen-lockfile` fails loudly instead of silently rewriting the lockfile, and
# `--prefer-offline` keeps a warm cache from hitting the network on every launch.
set -euo pipefail

./scripts/build-wasm.sh
cd web
pnpm install --frozen-lockfile --prefer-offline
pnpm dev
cd ..
