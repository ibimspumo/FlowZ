# FFmpeg sidecars

FlowZ bundles FFmpeg and FFprobe 8.1.2 for `aarch64-apple-darwin`. They were built
from the official release source at `https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz`.

- Source SHA-256: `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- `ffmpeg` SHA-256: `7f4fdbe0840a3e6281a4def25ea7977ce0ec233db660bf155b69ccbeb01ff5d5`
- `ffprobe` SHA-256: `99124fcb99763fa25e7a285b215490c472d007f2877c3ca013b3edeefee48323`

Build configuration:

```text
--disable-shared --enable-static --disable-doc --disable-debug --disable-network
--disable-autodetect --disable-iconv --disable-securetransport --disable-videotoolbox
--disable-audiotoolbox --disable-avfoundation --disable-sdl2 --disable-xlib
--disable-zlib --disable-bzlib --disable-lzma
```

The build environment sets `MACOSX_DEPLOYMENT_TARGET=11.0`. Both Mach-O files
declare `LC_BUILD_VERSION minos 11.0`; the Tauri bundle declares the same minimum.

The resulting programs report `LGPL version 2.1 or later` and link no Homebrew
libraries. Tauri's `externalBin` packaging places them inside the signed app bundle;
The sidecars are shipped inside the local FlowZ app bundle. This personal-use build is intentionally unsigned and does not require Apple notarization.
The corresponding LGPL text and FFmpeg licensing notes are stored beside this file.

Only the Apple-Silicon target is currently present. A release for another target must
provide binaries named with that target triple, reproduce this provenance record, and
pass the media integration tests on that architecture. Release builds intentionally do
not fall back to `$PATH`.
