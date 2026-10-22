# First public preview release checklist

Building is not publishing. Nothing in the package scripts or Windows preview
workflow changes repository visibility, creates a GitHub release or uploads
artifacts to a public release.

## Repeatable build

On Windows with Node >=22.12, Rust stable and C++ build tools:

```powershell
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm audit --omit=dev --audit-level=high
npm run package
npm run test:package
```

Quit any running AACpipe first; the smoke test refuses to take over a real
session. It uses isolated temporary pairing data and an ephemeral loopback port,
and removes that data afterward. `npm run test:package -- --screenshots` also
refreshes the README's receiver image using invented text only.

Outputs: `release\AACpipe Setup 0.1.0-preview.1.exe`,
`release\SHA256SUMS.txt` and `dist\THIRD-PARTY-NOTICES.txt`.
The manually dispatched Windows preview workflow repeats package/smoke checks
and uploads **Actions artifacts only**. It does not produce a public release.
These are reproducible steps, not a claim of byte-identical NSIS builds.

## Must decide/check before publishing

The maintainer has approved **Simon Judge** as author, the original blue
speech-bubble icon and an **unsigned, clearly labelled experimental preview**.
Physical acceptance has explicitly been deferred, not passed. No publication
approval has been given.

- [ ] Run and record the [physical acceptance matrix](acceptance-tests.md),
      particularly actual Grid, Android/iPhone and router-free hotspot.
- [ ] Test clean install, preview-to-preview upgrade and uninstall in an
      isolated Windows VM. Do not uninstall the maintainer's working setup.
- [x] Confirm author/icon and unsigned-preview choice with maintainer.
- [ ] Review final MIT copyright, release version and release notes before publication.
- [ ] Review the [security review and accepted limitation](security-review.md).
      Explicitly label any public build an experimental trusted-network preview.
- [ ] Recheck full npm audit; triage remaining build-time advisories rather than
      forcing breaking/downgrade fixes. Check Electron's own security releases.
- [ ] Verify packaged AACpipe MIT/third-party notices plus Electron's `LICENSE`
      and `LICENSES.chromium.html`; retain them with the app.
- [x] Keep this experimental preview **unsigned** by maintainer choice; do not
      claim a verified publisher or instruct users to disable security software.
- [ ] Enable **private vulnerability reporting** in GitHub Security settings
      when the repository becomes public, and verify the private report button.
      A read-only API check while private returned 404, not confirmation.
- [ ] Review repository/history for credentials, pairing links, personal text
      and screenshots; do not upload old private test evidence.
- [ ] Maintainer explicitly approves visibility change and release publication.
      Attach the installer, checksum, notices and matching release notes.

Upgrading **from old 0.1.0** can reset data because its old uninstaller deletes
data unconditionally. The new uninstaller preserves data during future upgrades
but cannot change an already-installed old uninstaller. Set that expectation.

## Broader supported release gate

Authenticated HTTPS/WSS or another authenticated receiver bootstrap is required
before claiming protection against active network attackers. That is not
implemented by `.local` discovery or encrypted message payloads.
