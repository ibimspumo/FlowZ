#!/usr/bin/env bash
set -euo pipefail

repository=${FLOWZ_REPOSITORY:-https://github.com/ibimspumo/FlowZ.git}
ref=${1:-main}
workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT

git clone --depth 1 --branch "$ref" "$repository" "$workspace/FlowZ"
cd "$workspace/FlowZ"
git ls-files --error-unmatch .github/workflows/ci.yml .github/workflows/release.yml src-tauri/binaries/SHA256SUMS pnpm-lock.yaml src/nodes/brand/google-fonts.catalog.json >/dev/null
corepack prepare pnpm@11.10.0 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm run verify:release
corepack pnpm run verify:fonts
corepack pnpm run verify:secrets
corepack pnpm run verify:icons
shasum -a 256 -c src-tauri/binaries/SHA256SUMS
corepack pnpm test
corepack pnpm run build
corepack pnpm run verify:lazy
cargo metadata --locked --manifest-path src-tauri/Cargo.toml >/dev/null
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
