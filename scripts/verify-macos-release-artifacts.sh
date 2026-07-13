#!/usr/bin/env bash
set -euo pipefail

version=${1:?usage: verify-macos-release-artifacts.sh <version>}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo 'Release version must be a stable semantic version.' >&2
  exit 1
}
app=src-tauri/target/aarch64-apple-darwin/release/bundle/macos/FlowZ.app
dmg="src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/FlowZ_${version}_aarch64.dmg"
archive="$app.tar.gz"
signature="$archive.sig"
source_archive="$app/Contents/Resources/licenses/ffmpeg/source/ffmpeg-8.1.2.tar.xz"
source_sha256=464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c

verify_adhoc_signature() {
  local path=$1 metadata
  codesign --verify --strict --verbose=2 "$path"
  metadata=$(codesign -dv --verbose=4 "$path" 2>&1)
  grep -Fq 'Signature=adhoc' <<< "$metadata"
  grep -Fq 'TeamIdentifier=not set' <<< "$metadata"
}

verify_arm64_binary() {
  local binary=$1 minos
  test "$(lipo -archs "$binary")" = arm64
  minos=$(otool -l "$binary" | awk '/LC_BUILD_VERSION/{active=1} active && /minos/{print $2; exit}')
  test "$minos" = 11.0
  verify_adhoc_signature "$binary"
}

test -d "$app" && test ! -L "$app" && test -s "$dmg" && test -s "$archive" && test -s "$signature"
codesign --verify --deep --strict --verbose=2 "$app"
verify_adhoc_signature "$app"

for binary in "$app/Contents/MacOS/flowz" "$app/Contents/MacOS/ffmpeg" "$app/Contents/MacOS/ffprobe"; do
  verify_arm64_binary "$binary"
done

test "$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$app/Contents/Info.plist")" = 11.0
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$app/Contents/Info.plist")" = icon.icns
test -s "$app/Contents/Resources/icon.icns"
test -s "$app/Contents/Resources/licenses/ffmpeg/README.md"
test -s "$app/Contents/Resources/licenses/ffmpeg/LICENSE.md"
test -s "$app/Contents/Resources/licenses/ffmpeg/COPYING.LGPLv2.1"
test -s "$source_archive"
test "$(shasum -a 256 "$source_archive" | awk '{print $1}')" = "$source_sha256"
test "$(tar -tf "$source_archive" | sed -n '1p')" = "ffmpeg-8.1.2/"

hdiutil verify "$dmg"
mountpoint=$(mktemp -d)
device=''
cleanup() {
  if [[ -n "$device" ]]; then
    hdiutil detach "$device" >/dev/null 2>&1 || true
  fi
  rmdir "$mountpoint" 2>/dev/null || true
}
trap cleanup EXIT
device=$(hdiutil attach -nobrowse -noautoopen -readonly -mountpoint "$mountpoint" "$dmg" | awk '/^\/dev\// { print $1; exit }')
test -n "$device"
mounted_app="$mountpoint/FlowZ.app"
test -d "$mounted_app" && test ! -L "$mounted_app"
diff -qr "$app" "$mounted_app"
codesign --verify --deep --strict --verbose=2 "$mounted_app"
verify_adhoc_signature "$mounted_app"
for binary in "$mounted_app/Contents/MacOS/flowz" "$mounted_app/Contents/MacOS/ffmpeg" "$mounted_app/Contents/MacOS/ffprobe"; do
  verify_arm64_binary "$binary"
done
hdiutil detach "$device"
device=''
rmdir "$mountpoint"
trap - EXIT

cargo run --locked --quiet --manifest-path src-tauri/Cargo.toml --example verify_updater_signature -- src-tauri/tauri.conf.json "$archive" "$signature"
corrupt_archive=$(mktemp)
trap 'rm -f "$corrupt_archive"' EXIT
cp "$archive" "$corrupt_archive"
printf x >> "$corrupt_archive"
if cargo run --locked --quiet --manifest-path src-tauri/Cargo.toml --example verify_updater_signature -- src-tauri/tauri.conf.json "$corrupt_archive" "$signature" >/dev/null 2>&1; then
  echo 'Corrupted updater archive unexpectedly passed signature verification.' >&2
  exit 1
fi
rm -f "$corrupt_archive"
trap - EXIT

echo "Verified local macOS ARM64 release artifacts for FlowZ ${version}."
