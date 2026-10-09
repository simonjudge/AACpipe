# AACpipe

AACpipe is a local-first partner screen for an AAC user. It publishes the user's
composed message to a browser on a trusted local network or the AAC device's
hotspot.

The repository now contains a runnable **local-network MVP**. The Rust Grid 3
bridge, persistent Publisher channel registry, DPAPI-protected metadata,
encrypted proof-of-possession WebSocket session, local pairing/QR page, and
zero-install browser partner screen are operational and locally validated.
Physical Grid 3, Android, and iOS acceptance testing remains a release activity
because those devices are not available in this workspace. Protocol behavior is defined in
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

## Run the MVP

Stop any running `publisher:stub` process with `Ctrl+C`, then start the complete
Publisher:

```powershell
npm run mvp
```

The first launch creates a DPAPI-protected persistent Partner channel and
prints:

```text
AACpipe Publisher: partner screen listening on port 3210
AACpipe Publisher: pairing management http://127.0.0.1:3210/manage
```

1. Open `http://127.0.0.1:3210/manage` on the Windows AAC device.
2. Scan the QR code using the communication partner's phone or tablet. Both
   devices must be on the same trusted Wi-Fi network or the AAC device's
   hotspot.
3. If Windows Firewall prompts, allow Node.js on **Private networks** only.
4. Leave `npm run mvp` running and send commands from a second terminal:

```powershell
.\target\release\aacpipe-bridge.exe --sentence --text "Hello from AACpipe"
.\target\release\aacpipe-bridge.exe --word --text "partner"
.\target\release\aacpipe-bridge.exe --sentence --speak --text "This is the final sentence"
.\target\release\aacpipe-bridge.exe --clear
.\target\release\aacpipe-bridge.exe --status
```

The message appears on the partner screen. It disappears immediately on
`--clear`, WebSocket loss, or Publisher shutdown. Persistent pairing survives a
browser refresh and Publisher restart; no old message is restored before the
fresh authenticated snapshot.

Manage channels with:

```powershell
.\target\release\aacpipe-bridge.exe --pair --persistent --label "Second partner"
.\target\release\aacpipe-bridge.exe --revoke --channel <channel-id>
.\target\release\aacpipe-bridge.exe --revoke --all
```

Refresh the management page after a pair or revoke command. Pairing URLs contain
secrets and should only be shared with the intended communication partner.
Persistent metadata is stored under `%LOCALAPPDATA%\AACpipe`.

The MVP requires the Publisher terminal to remain running. Electron tray
packaging, bridge auto-start of the development Publisher, mDNS discovery, and
installer creation remain later packaging work.

## Publisher stub

Run the Milestone 3 Publisher stub with:

```powershell
npm run publisher:stub
```

The Publisher command automatically rebuilds the native Node addon before it
starts, preventing stale Rust/TypeScript interface mismatches. To build only
the addon, run `npm run native:build`.

The stub prints safe operational status lines when it starts and after each
bridge command. It reports the command, state, revision, channel count, and
subscriber count, but never prints composed text or pairing secrets.

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
