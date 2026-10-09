# AACpipe

AACpipe is a local-first partner screen for an AAC user. It publishes the user's
composed message to a browser on a trusted local network or the AAC device's
hotspot.

The repository has completed **Milestone 3: Native Bridge and Windows
Primitives**. The Rust Grid 3 bridge, per-user secure named pipe, DPAPI
integration, native Node addon, Publisher stub, cross-language IPC contract,
adversarial clipboard coverage, and kernel-level pipe security checks are
operational and locally validated. Protocol behavior is defined in
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
