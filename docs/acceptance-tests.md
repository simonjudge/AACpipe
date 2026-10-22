# Preview acceptance and compatibility

Do not infer phone/Grid compatibility from desktop automation. Record exact OS,
Grid, browser, device and network versions, date and result when testing.
Only invented message text and dummy pairings belong in test evidence.

| Environment | Status |
| --- | --- |
| Windows local protocol/native bridge tests | Automated; see build results |
| Packaged Electron and loopback receiver | Automated smoke script |
| Windows hostname resolution | Previously observed working |
| Windows VPN/SafeMove restricted LAN HTTP | Previously blocked; not a passing LAN test |
| Physical Grid 3 integration | Pending maintainer test |
| Android Chrome, `.local` and IP, home Wi-Fi | Pending |
| iPhone/iPad Safari, `.local` and IP, home Wi-Fi | Pending |
| Windows mobile hotspot without internet | Pending |
| IP change with stable `.local` reconnection | Pending physical-network test |
| Clean install, upgrade, uninstall in clean Windows VM | Pending |
| Background audio/TTS/wake on each phone | Pending; browser limitations expected |

Local preview validation passed: 130 TypeScript tests, 18 Rust tests, lint,
formatting, typecheck, Rust fmt/Clippy, full installer build and packaged smoke
(management isolation, QR fallbacks, clipboard, bridge message/clear,
show/hide, revoke and restart). The maintainer elected to leave physical and
clean-VM checks pending for later.

## Maintainer session

1. In a clean Windows test account/VM, install the unsigned preview. Record
   SmartScreen/firewall prompts and confirm only trusted Private-network access.
2. Verify shortcut, tray icon, About version, pairing window, hide/close/reopen,
   and quit. Check normal AAC communication still works independently.
3. Follow [Grid actions](grid3-test-cell-actions.md): sentence, word, speak and
   clear. Check first/cold content command does not cover Grid; show/hide alone
   and `--pair --show` work. Check duplicate, edit and empty-message cases.
4. On each physical receiver scan `.local`, then IP fallback. Test wrong adapter,
   mDNS blocked, no network, and recovery. The warning must offer IP fallback.
5. Repeat on a Windows hotspot with upstream internet disconnected. Confirm
   Grid speech and optional browser voice availability offline.
6. Test permanent reload, Publisher restart and IP-address change. Confirm a
   fresh snapshot, never stale restored content.
7. Enable each Options control separately and together; tap activation banner,
   lock/unlock and background the device. Record actual TTS/beep/wake behavior.
8. Create/revoke both permanent and one-time pairings in UI and by label.
   Confirm cancel leaves pairing valid; confirm Revoke disconnects the receiver.
   One-time reload/disconnect ends pairing; permanent Forget is local only.
9. Disconnect Wi-Fi, quit Publisher and clear in Grid. Check receiver text
   clears on detection; measure silent-loss timeout and live delivery latency.
10. Install a new preview over this preview with dummy permanent pairing, then
    restart and confirm identity/pairing persists. Finally uninstall and verify
    `%LOCALAPPDATA%\AACpipe` is removed. Do not test uninstall on real user data.
11. Review copied diagnostics and screenshots for private data before sharing.
    Attempt ordinary-browser `/manage`; it must return Forbidden.

Record failures in issues with synthetic examples. No physical rows should be
marked passed until the maintainer supplies results.
