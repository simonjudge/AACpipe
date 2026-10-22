# Privacy and trust

AACpipe is an additional partner display, not a replacement for the AAC user's
normal communication or speech output. Always keep that normal route available.

## What travels where

- The Windows Publisher serves the page and sends messages directly to paired
  receivers on your local network. No AACpipe account, analytics, cloud service
  or internet connection is required.
- Authentication and message encryption use the pairing secret. **The page
  itself is served over HTTP**: an active attacker on the network can replace
  it and steal that secret. Use only trusted networks or your own hotspot.
- mDNS broadcasts a device hostname, service port, protocol version and root
  path. It does not advertise pairing secrets, channel labels or message text.
- The receiver's optional speak-aloud uses its operating system/browser TTS.
  Voice processing and any network use depend on that platform and chosen
  voice. Do not assume every voice is offline; test in airplane mode with
  Wi-Fi enabled or leave this option off for sensitive conversations.

## Stored data

- Windows: permanent pairing metadata and DPAPI-protected secrets,
  revocation tombstones and discovery identity under `%LOCALAPPDATA%\AACpipe`.
  Message text is held in memory, not intentionally saved as history.
- Partner browser: permanent pairing credentials and options in site storage.
  These are sensitive credentials; anyone using that browser profile may use
  the pairing. The LOCAL profile cannot promise non-extractable key storage.
- One-time pairing credentials are memory-only. Closing, refreshing or losing
  the connection ends a one-time pairing.
- Normal Electron/browser caches, crash dumps, OS memory/swap and external
  screen-recording tools are outside a guarantee of forensic erasure.

## Clearing, forgetting and revoking

- **Clear** removes displayed content, not the pairing.
- Connection loss clears receiver content once detected; silent network loss
  requires heartbeat/timeout detection, so it is not instantaneous.
- **Forget** deletes this browser's saved pairing. It does not revoke the
  Publisher channel.
- **Revoke** invalidates the channel and disconnects the partner. An offline
  receiver learns of revocation when it next contacts the Publisher.
- Upgrades from this preview onward preserve app data. A normal uninstall
  deletes the Windows pairing/discovery data; the browser retains its local
  credentials until forgotten, but cannot use them with a new channel.

## Diagnostics and reports

Copy diagnostics includes version, OS version, counts, port, discovery status
and a bounded list of error codes. It deliberately excludes messages, partner
labels, IP addresses, hostnames, pairing links, cookies and secrets. Review it
before sharing. Avoid screenshotting QR codes or real messages in bug reports.

The pairing window now requires a capability provisioned by Electron: opening
`/manage` in an ordinary browser is intentionally refused, even on this PC.
