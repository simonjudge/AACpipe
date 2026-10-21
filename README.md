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

The first launch creates a DPAPI-protected persistent channel named `Partner 1`
and prints:

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
.\target\release\aacpipe-bridge.exe --revoke --label "Second partner"
.\target\release\aacpipe-bridge.exe --revoke --all
```

Labels are unique, ignoring case. Pairing with a label that is already in use is
refused; a persistent pairing without `--label` is named `Partner 1`,
`Partner 2`, and so on, and one-time pairings are named `One-time 1`,
`One-time 2`, and so on. The pairing window also has **New permanent pairing**
(with a required partner name), **New one-time pairing**, and a **Revoke**
button beside each pairing, which asks for confirmation first.

The pairing window refreshes after pair or revoke commands. Pairing URLs contain
secrets and should only be shared with the intended communication partner.
Persistent metadata is stored under `%LOCALAPPDATA%\AACpipe`.

Control the pairing window from the bridge with `--show` or `--hide` (single
dash `-show`/`-hide` also works), either on their own or added to any command:

```powershell
.\target\release\aacpipe-bridge.exe --show
.\target\release\aacpipe-bridge.exe --pair --persistent --label "Mum" --show
.\target\release\aacpipe-bridge.exe --hide
```

`--word`, `--sentence`, `--clear` and `--speak` hide the window automatically
(unless `--show` is added) so it never covers Grid 3, including when the bridge
starts AACpipe.

The development MVP requires its Publisher terminal to remain running. The
Grid 3 test package runs the Publisher in Electron with a tray/window shell;
A signed installer remains later work.

## Build and install the Grid 3 test package

The unsigned per-user Windows installer is built with:

```powershell
npm run package
```

Install the `AACpipe Setup 0.1.0.exe` artifact from `release`. The app starts
with a tray icon and opens the pairing window. Closing that window hides the
Publisher; use the tray menu to reopen it or quit. The Grid 3 bridge is installed
beside `AACpipe.exe` and starts the Publisher automatically when a Grid action
is invoked. For the first Grid session, launch AACpipe from the desktop shortcut
before operating the grid and wait for the pairing window; a cold Electron launch
can take several seconds. Configure Grid 3 to run:

```text
%LOCALAPPDATA%\Programs\AACpipe\aacpipe-bridge.exe
```

Use the action order in [the Grid 3 test-cell checklist](./docs/grid3-test-cell-actions.md).
The pairing window recommends a stable `.local` QR code and also displays
IP-address fallback QR codes for the available network interfaces;
the AAC device and partner device must be on the same trusted network or AAC
device hotspot. Allow the app on Private networks only if Windows Firewall
prompts. This test build is unsigned, so Windows may show a publisher warning.

### Stable .local address and IP fallbacks

AACpipe advertises a unique hostname such as `aacpipe-0123456789abcdef.local`
using mDNS, and an `_aacpipe._tcp.local` service with its listening port.
The identity is saved in `%LOCALAPPDATA%\AACpipe\discovery.json` and reused
after restarts. If another device claims the same name, the mDNS library
selects a conflict-free name and AACpipe saves it. No pairing secrets or
conversation content are advertised.

Scan the **Recommended: stable .local address** QR first. On a compatible
network this keeps the partner's browser address the same even when the AAC
device's IP address changes. Both devices must still share a trusted network
or the AAC device's hotspot; this does not add a direct-radio connection,
internet dependency, or HTTPS.

If the name does not resolve, scan the **IP-address fallback** for the shared
network instead. Some devices, VPNs, firewalls and guest networks block mDNS
(UDP 5353). Allow AACpipe on your trusted Private network; do not open router
ports to the internet. If discovery cannot start, AACpipe shows a warning
and continues accepting Grid commands and IP-address connections. Restart
AACpipe to retry discovery. It monitors network interfaces while running.

IP fallbacks use the same channel, encryption and revocation, but their address
can change with the network. Switching between an IP address and `.local`
requires scanning the pairing QR again because browser credentials and options
belong to each address separately. There is no automatic migration.
The Windows pairing window stays on `127.0.0.1`, and Grid's bridge still uses
its Windows named pipe.

For acceptance testing, try the recommended QR on both home Wi-Fi and the
Windows hotspot, then test an IP fallback. Check reconnect after restarting
AACpipe, and after an IP-address change on the same network. Physical
Android/iPhone and hotspot interoperability still needs testing.

### Partner page options

The partner page has an **Options** button in its top bar. All options are off
by default and are remembered only in that browser:

- **Read spoken messages aloud** uses the phone's text-to-speech when the AAC
  user speaks a message.
- **Play an alert tone** beeps when a message is spoken.
- **Keep the screen awake** uses the Wake Lock API where the browser allows it,
  otherwise a silent looping video. The local page is plain HTTP, so most phones
  use the video fallback; its effectiveness varies by phone.
- **Forget** removes the pairing from this browser only. The AAC user must still
  revoke the channel on the AAC device to remove it there.

Phones only allow sound and screen-wake after a tap, so after a reload the page
shows a "Tap here to turn on sound and keep the screen awake" banner. iPhones
mute the alert tone when the silent switch is on.

### One-time pairing

Select **New one-time pairing** in the pairing window or tray menu, or run
`aacpipe-bridge.exe --pair --ephemeral` from Grid 3; the pairing window pops up
with a one-time QR code. The pairing is held in memory only and ends when the
partner page disconnects or reloads, when its **Revoke** button is
selected, or when AACpipe quits. The partner then sees "One-time pairing ended".

Uninstalling this test build deletes AACpipe's pairing and configuration data
under `%LOCALAPPDATA%\AACpipe`. Pair again after reinstalling. The installer is
for local Grid 3 acceptance testing, not a signed or supported pilot release.

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

The Publisher stub is a development integration surface; the Grid 3 test package
uses a minimal Electron tray/window shell around the existing Publisher.

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

## Possible TODO: OCR-based Grid 3 monitoring

- [ ] Investigate local OCR of Grid 3's writing area as an optional alternative
      to the current clipboard-copy and run-program actions. Start with a
      feasibility probe to measure recognition accuracy and latency during
      typing, prediction selection, correction, clearing, and scrolling.

On the tested setup, an elevated accessibility inspector can see Grid 3's window
but exposes no writing-area text or child controls. No Grid API/hooks are
available for this integration, and monitoring TTS would miss silent composition
and edits while needing to accommodate both packaged voices and SAPI.

The OCR probe should capture only a user-selected writing-area region, process
images locally, and require stable recognition before sending authoritative
composition snapshots through the existing Publisher. Keep the clipboard bridge
available. Detect capture/recognition failures explicitly; an empty OCR result
must not automatically clear the partner screen, and scrolling must not be
mistaken for deletion.

Exact word-completion detection remains an open question: OCR often discards
trailing spaces, and a pause does not prove that a word is complete. Test whether
Grid's visual spacing or caret behaviour provides a reliable completion cue;
otherwise distinguish stable composition updates from confirmed word boundaries.

## Security scope

v0.1 intentionally uses a trusted-network LOCAL profile and does not claim
protection against an active local attacker. Do not use the system on a network
where intercepted or modified messages would be unacceptable.
