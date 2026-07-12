#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo 'The FlowZ release rehearsal requires an Apple-Silicon Mac.' >&2
  exit 1
fi

key_path=${FLOWZ_UPDATER_KEY_PATH:-$HOME/.tauri/flowz-updater.key}
keychain_service=${FLOWZ_UPDATER_KEYCHAIN_SERVICE:-dev.flowz.updater-signing}
test -f "$key_path"
test "$(stat -f '%Lp' "$key_path")" = 600

version=$(node -p "require('./package.json').version")
corepack pnpm run verify:release -- "v$version"
corepack pnpm run verify:fonts
corepack pnpm run verify:secrets
corepack pnpm run verify:icons
shasum -a 256 -c src-tauri/binaries/SHA256SUMS

export TAURI_SIGNING_PRIVATE_KEY="$key_path"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(security find-generic-password -s "$keychain_service" -w)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
trap 'unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD' EXIT

corepack pnpm exec tauri build --ci --no-bundle --target aarch64-apple-darwin -- --locked
corepack pnpm exec tauri bundle --ci --target aarch64-apple-darwin --bundles app,dmg
bash scripts/verify-macos-release-artifacts.sh "$version"

echo 'Release rehearsal passed. No tag, GitHub Release or remote artifact was created.'
