# AACpipe

AACpipe is a local-first partner screen for an AAC user. It publishes the user's
composed message to a browser on a trusted local network or the AAC device's
hotspot.

The repository has completed implementation through **Milestone 7** for the
testable vertical slice. The Rust Grid 3 bridge, persistent Publisher channel
registry, DPAPI-protected metadata, encrypted proof-of-possession session,
browser-facing Subscriber controller, pairing storage adapters, and in-memory
end-to-end test path are operational and locally validated. The current
vertical-slice crypto adapter is Node-based; a browser Web Crypto/bundled
implementation is still required before deploying the Subscriber SPA. Physical
Grid 3, Android, and iOS acceptance testing remains a release activity because
those devices are not available in this workspace. Protocol behavior is defined in
[the protocol specification](./AACPipe%20Partner%20Screen%20App%20Protocol.md).

## Development prerequisites

- Windows is the supported development and release platform for v0.1.
- Node.js 22 LTS or newer.
- npm 10 or newer.
- Rust stable with Cargo.
- Visual Studio Build Tools with the Desktop development with C++ workload for
  native Windows builds.

If Rustup was installed during an existing terminal session and PowerShell
reports that `cargo` is not recognized, open a new terminal. To refresh the
current PowerShell session without restarting it, run:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
```

Confirm the installation with:

```powershell
cargo --version
```

## Install and validate

```powershell
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:vertical-slice

cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Build the native Node addon and run the Milestone 3 Publisher stub with:

```powershell
npm run native:build
npm run publisher:stub
```

In another terminal, build and invoke the bridge:

```powershell
cargo build --release -p aacpipe-bridge
.\target\release\aacpipe-bridge.exe --sentence --text "Hello from AACpipe"
.\target\release\aacpipe-bridge.exe --status
```

The Publisher stub is a development integration surface, not the final Electron
Publisher UI planned for Milestone 4.

The complete encrypted vertical slice can be run with:

```powershell
npm run test:vertical-slice
```

It exercises compact pairing, persistent credential storage, challenge/proof
authentication, AES-GCM state updates, clear-content semantics, reconnect
synchronisation, and revocation credential deletion.

Grid 3 cell ordering and command authoring are documented in
[docs/grid3-test-cell-actions.md](./docs/grid3-test-cell-actions.md).

## Planned components

- `apps/publisher`: resident Windows Publisher and management UI.
- `apps/subscriber`: zero-install browser Subscriber.
- `packages/`: shared protocol, cryptography, domain, IPC, and test contracts.
- `crates/bridge`: fast native Grid 3 command bridge.
- `crates/win32-native`: Windows named-pipe and protected-storage integration.

See [implementation_plan.md](./implementation_plan.md) for milestones, tasks,
acceptance criteria, decisions, and the open-decision checklist.

## Security scope

v0.1 intentionally uses a trusted-network LOCAL profile and does not claim
protection against an active local attacker. Do not use the system on a network
where intercepted or modified messages would be unacceptable.
