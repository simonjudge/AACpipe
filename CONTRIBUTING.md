# Contributing

## Before changing code

1. Read [implementation_plan.md](./implementation_plan.md).
2. Read [AACPipe Partner Screen App Protocol.md](./AACPipe%20Partner%20Screen%20App%20Protocol.md).
3. Check the relevant milestone and open decisions.
4. Keep protocol, implementation, and test-vector changes synchronized.

## Validation

Run the smallest relevant checks while working, then run the full foundation
checks before marking a task complete:

```powershell
npm run lint
npm run format:check
npm run typecheck
npm test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Do not commit secrets, pairing URLs, decrypted composition text, or generated
release artifacts.

Use Node >=22.12, Rust stable and Windows C++ build tools. For UI changes run
`npm run package` and `npm run test:package` with the real AACpipe app closed.
The pairing UI requires an Electron-provisioned management capability; do not
weaken authentication or print the capability for headless development.
See [development](docs/development.md) and the
[release checklist](docs/release-checklist.md). The Windows preview workflow
uploads test artifacts, not public releases. Report vulnerabilities privately
as described in [SECURITY.md](SECURITY.md).

Update the implementation plan when a task is completed, blocked, or materially
changed. Add a decision-log entry for architecture changes.
