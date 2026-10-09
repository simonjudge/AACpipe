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

Update the implementation plan when a task is completed, blocked, or materially
changed. Add a decision-log entry for architecture changes.
