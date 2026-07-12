# FlowZ Release Security

## Trust boundary

FlowZ macOS releases are ad-hoc signed and not Apple-notarized. The ad-hoc signature protects bundle integrity after assembly but does not establish an Apple-verified publisher identity. Tauri updater packages have a separate mandatory Minisign signature; the public key is embedded in `tauri.conf.json`, while the private key exists only in local secure storage and GitHub Actions Secrets.

## Workflow permissions

| Job | Repository permission | Credentials | Purpose |
| --- | --- | --- | --- |
| CI | `contents: read` | none | Versions, sidecar hashes, tests, build, fmt, Clippy |
| Release build | `contents: read`, `actions: read` | updater secrets from the protected `release-signing` environment on the single bundle step only | Prove main/CI provenance, compile, ad-hoc sign, create and verify updater artifacts |
| Release publish | `contents: write`, `actions: read` | step-scoped `GITHUB_TOKEN` only | Download the verified workflow artifact, create a draft, upload, redownload, verify and publish |

Checkout never persists Git credentials. Every reusable Action is pinned to a full commit SHA. Rust is pinned to a concrete toolchain and every dependency-resolving Cargo path is lockfile-bound. Signing credentials are not job-level environment variables and are unavailable to checkout, dependency installation, tests, builds, caches or artifact Actions. The `release-signing` GitHub Environment contains the updater secrets; ordinary repository secrets are not the intended configuration. Configure a required reviewer whenever the repository plan supports that protection, but Environment-scoped secret isolation remains mandatory either way.

## Mandatory release gates

- Only stable versions enter this workflow. The tag equals every application version, its commit is an ancestor of `origin/main`, and a successful completed `CI` push run for that exact commit must already exist.
- `pnpm install --frozen-lockfile`, `cargo metadata --locked`, locked Clippy/tests and the locked Tauri build prove both committed dependency graphs are immutable.
- The committed Google-Fonts catalog, lazy-chunk budgets and secret-pattern scan pass before compilation.
- Bundled FFmpeg and FFprobe match committed SHA-256 hashes, are executable and are ARM64.
- The final app, main binary and both sidecars pass strict ad-hoc codesign verification.
- Main binary and sidecars are ARM64 with macOS 11.0 as their minimum target; the app plist declares the same floor.
- The icon-generation manifest cryptographically binds the 1024 px master to the generated PNG/ICNS/ICO/Web outputs; the final app contains that generated icon.
- Bundled FFmpeg license/build notices are present in the app. The release also publishes the exact official FFmpeg 8.1.2 source tarball, verifies its pinned SHA-256 and includes the build configuration beside it.
- The DMG passes `hdiutil verify` and mounts read-only without Finder auto-open. Its app tree must byte-match the already verified bundle; the mounted app, main binary and sidecars repeat the ad-hoc/no-Team-ID, ARM64 and macOS 11.0 checks.
- The generated updater signature verifies against the exact public key embedded in `tauri.conf.json`; a deliberately corrupted archive must fail the same verifier.
- `latest.json` is checked for version, `darwin-aarch64`, exact archive URL and exact signature contents.
- Published assets are downloaded again and checked against `SHA256SUMS.txt` before the draft becomes the latest public release.

## Deferred P0: initial repository publication

The workspace currently has no tracked initial commit containing the application and workflows. A GitHub-hosted clean-checkout run therefore cannot prove the pipeline until the overall product implementation is complete and the user intentionally creates and pushes the initial commit. This is deliberately deferred; it must not be silently treated as complete.

Immediately after that intentional push, run:

```bash
bash scripts/verify-clean-checkout.sh main
```

Then open a pull request and require the pinned `CI` workflow to pass from GitHub's own clean checkout. Only after both checks pass may the first version tag be pushed. The first tag run must remain draft until artifact redownload, checksum, updater JSON and signature validation have passed.

Before the first release, replace the icon master if required and run `corepack pnpm icons`. CI requires the exact 1024 px master, a matching generation manifest, the generated ICNS/ICO/PNG assets and byte-identical web icon; it never generates or substitutes artwork during a release.

## First tag runbook

The updater signature is free Minisign-based Tauri infrastructure. It does not require an Apple Developer account, Developer ID certificate or notarization subscription. Before pushing the first tag:

1. Confirm that `git remote get-url origin` is `https://github.com/ibimspumo/FlowZ.git` and that the updater endpoint in `tauri.conf.json` names the same repository.
2. Create the GitHub Environment `release-signing`, restrict it to protected tags matching `v*`, and configure a required reviewer where the repository plan supports that protection.
3. Add `TAURI_SIGNING_PRIVATE_KEY` to that Environment with the complete contents of `~/.tauri/flowz-updater.key`. Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from the macOS Keychain service `dev.flowz.updater-signing`. Do not use a repository variable and do not commit either value.
4. Back up both values in an independent encrypted secret manager, then run `bash scripts/rehearse-macos-release.sh`. This creates and verifies the ARM64 app, DMG, updater archive and signature locally, but performs no Git or GitHub mutation.
5. Push the application to `main`, run `bash scripts/verify-clean-checkout.sh main`, and wait for the exact commit's `CI` push run to succeed.
6. Only then create and push the stable `v<package-version>` tag. Watch the release workflow through its draft, redownload and checksum gates. A failed run must not be worked around by manually publishing its draft.

For authenticated setup, `gh secret set --env release-signing TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/flowz-updater.key` reads the key without placing it in shell history. Pipe the Keychain value directly into the corresponding `gh secret set --env` command; never echo it or pass it as a command-line argument.

`scripts/verify-macos-release-artifacts.sh` is shared by the local rehearsal and GitHub Actions. This prevents the architecture, ad-hoc signature, DMG, embedded-license and Minisign checks from drifting between the two paths.

## Key recovery

The local updater private key is stored at `~/.tauri/flowz-updater.key` with mode `0600`; its password is stored in the macOS Keychain service `dev.flowz.updater-signing`. Losing the private key prevents shipping compatible updates to existing installations. Back up the key and password in an independent encrypted secret manager before the first public release. Never add either value to project files, logs, shell history or release assets.
