use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn verify_sidecar(name: &str, target: &str, expected: &str) {
    let path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"))
        .join("binaries")
        .join(format!("{name}-{target}"));
    println!("cargo:rerun-if-changed={}", path.display());
    let bytes = fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "required media sidecar {} is missing: {error}",
            path.display()
        )
    });
    let actual = format!("{:x}", Sha256::digest(&bytes));
    assert_eq!(
        actual,
        expected,
        "media sidecar {} does not match the reviewed binary",
        path.display()
    );
}

fn main() {
    let target = env::var("TARGET").expect("target triple");
    match target.as_str() {
        "aarch64-apple-darwin" => {
            verify_sidecar(
                "ffmpeg",
                &target,
                "7f4fdbe0840a3e6281a4def25ea7977ce0ec233db660bf155b69ccbeb01ff5d5",
            );
            verify_sidecar(
                "ffprobe",
                &target,
                "99124fcb99763fa25e7a285b215490c472d007f2877c3ca013b3edeefee48323",
            );
        }
        unsupported => panic!(
            "FlowZ has no reviewed FFmpeg sidecars for target {unsupported}; add binaries, licenses, and pinned hashes before building"
        ),
    }
    tauri_build::build()
}
