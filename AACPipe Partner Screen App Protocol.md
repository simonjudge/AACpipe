# **AACpipe Protocol Specification (v0.1)**

**Status:** Local-Only / Serverless Architecture  
**Target Audience:** AAC Developers, System Architects, & Open-Source Maintainers

1. ## **Overview and Architecture**

The AACpipe framework defines an open, local-first real-time communication pipeline between an Augmentative and Alternative Communication (AAC) device acting as a **Publisher Host** and one communication partner display per channel acting as a **Subscriber**. The protocol delivers real-time updates as the user composes messages—serving as a low-latency remote "Partner Screen". The model is intentionally designed to be extensible to multiple simultaneous subscribers in the future.

**Serverless Peer-to-Host Design:** There are no external servers or relays used. The Publisher daemon embedded on the AAC device hosts both the HTTP web server (serving the subscriber single-page app) and the WebSocket communication server locally on the local network.

The initial protocol intentionally prioritizes a zero-install local experience over strong active-attack resistance.

**In other words - this is NOT A SECURE system - someone might be able to see your messages**

**You could consider this in the same way as thinking about a verbal conversation - someone nearby (even just outside your house) might be able to hear a conversation you are having. If you have the conversation in a public place (on a public network in this analogy) it is much easier for someone to listen in. Assume anything you say on this system could be intercepted by someone malicious.**

This is appropriate for a first deployment on a trusted local network or the AAC device’s own hotspot. The protocol is designed to allow a more secure deployment mode later, using mutually authenticated HTTPS/WSS and stronger device identity or certificate pinning without changing the core channel model.

Inspired by Meredith Ringel Morris’ research on partner apps, AACpipe can be extended to support bidirectional interaction where trusted partners contribute word completions, predictions, and contextual hints without compromising the AAC user’s conversational agency.

Initially the protocol will be used to transmit and render text, but the protocol can also be extended to include symbol support.

The protocol could also be deployed on a stand-alone partner screen.

### **Design Constraints for v0.1**

- **Primary priority:** zero-install, low-friction pairing.
- **Initial release target:** Windows only. Grid 3 integrates by launching a short-lived AACpipe command-line bridge, with the message text passed on the Windows clipboard and the intent passed as a command flag.
- **Initial channel model:** one partner per channel, content-read-only, extensible to future multi-partner support. The Subscriber may send protocol-control frames required for authentication, heartbeat, and capability negotiation, but cannot submit AAC content or commands.
- **Initial network model:** trusted home Wi-Fi or the AAC device’s own hotspot; not intended for arbitrary public Wi-Fi without extra trust controls.
- **Persistent sessions:** pairing credentials persist on both Publisher and Subscriber until the AAC user revokes them. Browser reload and transient connection loss do not require another QR scan.
- **Content clearing:** the AAC user can clear the current message and all retained channel content without revoking the channel or destroying its pairing credentials.
- **Connection loss behavior:** on unexpected disconnect, visible text and in-memory message content are cleared immediately. A persistent pairing credential is retained only to permit authenticated reconnection.

1. ### **Components**

| Component                   | Responsibility                                                                                                                                                                                                                                                                                                                | Implementation Targets                                                                                                                                           |
| :-------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Publisher Engine & Host** | Long-running resident service. Owns the authoritative composition buffer and channel registry, runs a local embedded HTTP/WebSocket server, hosts static Subscriber SPA assets, manages cryptographic channel keys, renders dynamic QR code pairings, receives local WebSocket connections, and processes encrypted payloads. | Windows background process with a tray UI for the first release; future Node.js / Rust / Go / C\# daemons for wider deployment.                                  |
| **Command Bridge**          | Short-lived executable launched by the AAC application once per user action. Reads the intent from its command flag and the text from the clipboard, forwards a single command to the resident Publisher over local IPC, then exits. Holds no channel state and never touches the network.                                    | `aacpipe.exe` on Windows, invoked from a Grid 3 cell's "Run program" command.                                                                                    |
| **Subscriber Web App**      | Zero-install Web Application downloaded directly from the AAC device's local HTTP server. Imports pairing credentials from the initial URL fragment, persists persistent-channel credentials in browser storage, renders distance typography, and clears message content on connection loss.                                  | Pure Single-Page Application (HTML5/TS/JS) served directly over home Wi-Fi or a device hotspot to standard partner mobile browsers (iOS Safari, Android Chrome). |

2.  ### **Channels**

AACpipe maintains isolated channels for persistent and ephemeral interactions. The AAC user can create independent channels for different partners (e.g., one persistent read-only channel for a primary caregiver, and a temporary read-only ephemeral channel for a store clerk). Each channel utilizes an independent cryptographic secret and explicit permission flags. v0.1 permits one Subscriber credential per channel; a future version may associate multiple independently revocable Subscriber credentials with one logical channel.

|                          | Persistent Channel (type: "p")                                                                                                                                                                                                                                                                   | Ephemeral Channel (type: "e")                                                                                               |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| **Target Use Case**      | Family, primary caregivers...                                                                                                                                                                                                                                                                    | Cashiers, one-off encounters.                                                                                               |
| **Lifespan**             | Indefinite. Publisher and Subscriber pairing records persist across AAC app restarts, browser reloads, and transient disconnections until explicitly revoked by the AAC user, subject to the browser-storage limitations below.                                                                  | Ends on WebSocket disconnect, a user-configured connected-idle timeout (default: 30 minutes), or manual closure.            |
| **Revocation Mechanism** | Explicit "Reset Key / Revoke Session" trigger in Publisher management UI.                                                                                                                                                                                                                        | Connected-idle timeout, socket disconnection, or manual cancellation action. Browser page-exit signals are not relied upon. |
| **Default Permissions**  | Read-Only (prm: "ro") in v0.1; future read-write with explicit permission gating.                                                                                                                                                                                                                | Read-Only (prm: "ro") by default.                                                                                           |
| **Storage Profile**      | Publisher credential is persisted in the Windows user’s protected application storage. Subscriber credential is persisted in origin-scoped browser storage. Message content is never persisted by the Subscriber. Clearing channel content preserves both credentials; revocation destroys them. | Publisher and Subscriber credentials are held in memory only and wiped on disconnect, timeout, or manual closure.           |
| **Addressing Endpoint**  | `http://aacpipe.local:8080/#2:{channelId}:{base64Key}` (WebSocket handshake: `ws://aacpipe.local:8080/?cid={channelId}`)                                                                                                                                                                         | `http://aacpipe.local:8080/#0:{channelId}:{base64Key}` (WebSocket handshake: `ws://aacpipe.local:8080/?cid={channelId}`)    |

> **v0.1 permission scope**: The initial release is content-read-only in both persistent and ephemeral channels. Subscriber-to-Publisher authentication and control traffic does not grant permission to submit suggestions, modify the buffer, invoke speech, or issue AAC commands. The protocol supports future write capabilities and partner suggestion payloads, but these are not part of the first implementation.

3. ### **States and Event Types**

| Event Type      | State     | Description                                                                                                     | Purpose / Trigger                                                                                                 |
| :-------------- | :-------- | :-------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| STATE\_UPDATE   |           | Publisher → Subscriber                                                                                          | Transmits real-time composition changes, buffer text, and speaker status.                                         |
|                 | IDLE      | The authoritative Publisher buffer is empty without an explicit clear event, including the initial empty state. | Displays the connected empty-state UI. It does not expire a channel by itself.                                    |
|                 | COMPOSING | The AAC application appends a word or replaces the message, via a `--word` or `--sentence` bridge command.      | Renders active buffer text; displays "User is typing..." indicator.                                               |
|                 | SPEAKING  | The AAC application signals text-to-speech playback, via a `--speak` bridge command.                            | Animates active message container (e.g., high-contrast pulse/outline) to highlight spoken output.                 |
| CLEAR\_BUFFER   |           | Publisher → Subscriber                                                                                          | The AAC application issued a `--clear` bridge command, or the user cleared channel content from the Publisher UI. | Clears browser text and all in-memory content state immediately while preserving the persistent pairing and connection. |
| SYSTEM\_REVOKED |           | Publisher → Subscriber                                                                                          | Signals immediate session key destruction and subscriber disconnection.                                           |

> **Connection-loss handling**: When a socket disconnects unexpectedly, the Subscriber must immediately clear the displayed message and all in-memory message state. For a persistent channel, it retains the durable pairing credential, attempts to reconnect and re-authenticate, and does not require another QR scan. It must not redisplay locally cached text. After authentication, the Publisher sends a fresh authoritative state snapshot; the Subscriber displays that snapshot only while the connection remains authenticated. An ephemeral channel deletes its credential on disconnect and cannot reconnect without a new pairing.

> **Ephemeral inactivity**: The connected-idle timeout measures the absence of successful WebSocket heartbeat responses while the socket remains open, not the absence of AAC composition. The Publisher sends a WebSocket protocol ping at a configurable interval shorter than the timeout; a received pong refreshes channel activity. Standard browsers respond at the WebSocket implementation layer. A healthy connected channel therefore does not expire merely because the AAC user pauses composing. Missing the configured heartbeat threshold closes the socket, and disconnection ends an ephemeral channel immediately.

4.  ### **Direct Local Dynamic URL Schema**

**Direct Host Targeting:** Scanning the QR code points the partner browser directly to the AAC device's embedded HTTP server without querying external DNS or internet routes.

When a channel is created, the Publisher resolves its local IP address or local mDNS hostname (e.g., 192.168.1.45 or aacpipe.local) and generates a 256-bit channel secret (${K}_{c}$) used as key material. The pairing QR code encodes a direct local URL.

To maximize QR scan reliability across distances and under poor lighting, the dynamic URL utilizes a compact positional format in the location fragment (\#):

```
http\://{host}:{port}/\#{flag}:{channelId}:{base64Key}
```

- **flag (1 Character):** Encodes the requested channel type and permissions into a single numeric bitmask:
  - 0: Ephemeral, Read-Only (t=e, prm=ro)
  - 1: Reserved for future Ephemeral, Read-Write (t=e, prm=rw)
  - 2: Persistent, Read-Only (t=p, prm=ro)
  - 3: Reserved for future Persistent, Read-Write (t=p, prm=rw)
- **channelId (17 Characters):** A cryptographically random 96-bit value encoded as fixed-length Base62 (e.g., x7K9pL3mN2qR8TvQa). Encoders preserve leading zero digits so every channel ID is exactly 17 characters.
- **base64Key (43 Characters):** The 256-bit symmetric key material in unpadded Base64URL format.

The URL flag is a client hint only. The Publisher's channel registry is authoritative for channel type, permission, expiry, and supported capabilities. A modified flag must never elevate a channel's permissions.

> **v0.1 trust model**: This zero-install flow is intentionally optimized for a trusted local network or the AAC device’s hotspot. It is not a claim of strong protection against an active local attacker. A stricter secure mode is planned and should be implemented as an explicit alternative to the zero-install path.

#### **Persistent Subscriber Credential Storage**

On the first successful opening of a persistent pairing URL, the Subscriber:

1. Parses the channel ID, endpoint, channel type, and channel secret from the URL fragment.
2. Persists a pairing record containing the protocol version, channel ID, transport profile, endpoint or stable Publisher hostname, channel type, and channel secret in origin-scoped browser storage. IndexedDB is preferred. Where a secure browser context and browser support permit, the secret should be imported and stored as non-extractable cryptographic key material. In the LOCAL profile, the browser may have to store extractable key bytes because Web Crypto is not guaranteed to be available.
3. Immediately removes the fragment from the visible URL using browser history replacement, without navigating or reloading the page.
4. Uses the persisted pairing record on browser reload and subsequent reconnections. It must not require the QR code again unless the channel has been revoked or the partner deliberately clears browser site data.

The Subscriber must not persist composition text, symbols, decrypted payloads, suggestions, or prior state snapshots. It may persist non-sensitive accessibility preferences separately from the pairing record.

Browser private modes, storage eviction policies, or operating-system deletion of site data may remove the local pairing record; this is an external deletion rather than protocol revocation. The Publisher channel remains valid, but that Subscriber will need the existing channel QR to restore its local credential. A browser that cannot demonstrate durable origin storage must warn that persistent pairing is unavailable rather than silently treating the channel as persistent. Under normal supported-browser operation, reload, tab closure, browser restart, Publisher restart, and transient network loss do not delete a persistent pairing record.

Persistent pairing URLs use a stable, per-Publisher mDNS hostname so the browser origin and stored pairing record remain stable across local IP address changes. The illustrative default `aacpipe.local` is suitable only when there is one AACpipe Publisher on the network. An implementation must derive and persist a collision-resistant hostname such as `aacpipe-{deviceId}.local`, handle mDNS collision renaming consistently, and continue advertising the same hostname after restart. Direct-IP URLs are intended primarily as an ephemeral fallback and must not be offered as durable persistent pairing.

5. ### **mDNS Addressing (aacpipe.local)**

- The Publisher daemon advertises its local network service via Multicast DNS as `_aacpipe._tcp.local` and binds to its persisted, collision-resistant per-Publisher hostname. Examples use `aacpipe.local` for readability only.
- **Dynamic Pairing URL:**

```
  http://aacpipe.local:8080/#{flag}:{channelId}:{base64Key}`
```

- **Fallback**: If mDNS resolution fails on certain legacy Android or locked-down network configurations, an ephemeral QR code can use the AAC device's current IPv4 address, for example:

```
  http://192.168.1.45:8080/#{flag}:{channelId}:{base64Key}`
```

> **Network requirements**: The v0.1 protocol is for home Wi-Fi or the AAC device's hotspot. It is not designed for arbitrary public Wi-Fi without additional trust controls or a secure authenticated deployment mode.

#### **Transport Security Profiles**

The channel, authentication, state, clear-content, reconnection, and revocation semantics are independent of the transport security profile:

- **LOCAL (required by v0.1):** Uses HTTP and WebSocket on trusted home Wi-Fi or the AAC device's own hotspot. Application-layer authentication and encryption protect against accidental access and passive observation after the authentic application has loaded, but cannot protect against an active local attacker replacing the HTTP application or WebSocket endpoint.
- **SECURE (reserved extension):** Uses authenticated HTTPS and WSS with a trusted Publisher identity. The identity may be provisioned through a trusted installed application, a publicly trusted certificate, or another future bootstrap mechanism. An ordinary zero-install browser must not claim certificate pinning unless its platform provides a trustworthy way to establish that pin.

Both profiles use the same channel identifiers, pairing lifecycle, permissions, and encrypted application-frame format. A Subscriber that has stored a channel as `SECURE` must reject downgrade to `LOCAL`.

The LOCAL v0.1 Subscriber is an ordinary single-page web application, not an installable PWA: LAN HTTP origins generally cannot register service workers or rely on secure-context-only PWA features. A future SECURE deployment may add installable-PWA behavior without changing the protocol.

6. ### **AES-256-GCM Encrypted Pipeline**

> - **Key Generation:** Keys are generated using cryptographically strong pseudo-random number generators (CSPRNG) via Web Crypto API or native OS libraries.
> - **Browser Crypto Availability:** HTTP pages on LAN addresses are not secure browser contexts and may not expose Web Crypto `SubtleCrypto`. The LOCAL profile must feature-detect required APIs and, if necessary, use a reviewed cryptographic implementation bundled with the offline application. It must never download cryptographic code at runtime.
> - **Key Separation:** The QR secret is input key material, not a traffic key. HKDF-SHA-256 derives a dedicated handshake key and fresh Publisher-to-Subscriber and Subscriber-to-Publisher traffic keys. Derivation context includes `AACpipe`, protocol major version, channel ID, connection ID, and direction.
> - **IV Management:** Each traffic direction uses a fresh per-connection key and a 96-bit IV formed from a derived 32-bit nonce prefix followed by the frame's unsigned 64-bit sequence number in network byte order. Sequence numbers start at zero and increase by one for each encrypted frame. A key and IV pair must never be reused. Sequence exhaustion closes the connection and requires a new handshake.
> - **Authenticated Envelope:** AES-GCM uses a 128-bit authentication tag. Protocol version, channel ID, connection ID, direction, and sequence number are authenticated as associated data using a specified length-prefixed binary encoding. The IV is derived from the traffic key context and `seq`; it is not transmitted in the envelope. Frames with an invalid tag, duplicate or decreasing sequence, malformed field, or unexpected direction are rejected and the socket is closed.
> - **URL Fragment Bootstrap (\#):** During initial pairing, key material is delivered in the browser fragment so it is not transmitted in HTTP request headers or logged by the Publisher web server. The Subscriber then imports the credential into the storage profile required by the channel type and immediately removes the fragment from the visible URL. Persistent credentials remain in origin-scoped browser storage; ephemeral credentials remain in memory only.
> - **No Content Logging:** The Publisher and Subscriber must not log pairing secrets, decrypted composition text, encrypted payloads, or complete pairing URLs.

7. ### **Subscriber Authentication & Selective Channel Routing**

To prevent metadata leakage and unnecessary local bandwidth consumption, the host daemon routes WebSocket frames strictly to authenticated sockets assigned to specific channel IDs.

- **Selective Connection Routing (cid Query Parameter):**  
  The subscriber initiates the WebSocket connection using the channel ID extracted from the URL fragment:  
  ws://{host}:{port}/?cid={channelId}  
  The host daemon parses cid during the HTTP Upgrade request and assigns the unauthenticated socket to an isolated channel pending pool.
- **Proof-of-Possession Handshake (HMAC-SHA256):**  
  To reduce unauthorized device connections on the local network, subscribers must prove possession of key material derived from ${K}_{c}$ before encrypted streaming begins. This remains a local-network authorization mechanism for the zero-install flow and is not intended to replace strong transport security in a more protected deployment.  
  **Step 1 (Server Challenge):** Upon connection, the Publisher generates a cryptographically random 16-byte connection ID and 16-byte server nonce and transmits an unencrypted CHALLENGE frame with its supported capabilities:  
  JSON { "v": 1, "type": "CHALLENGE", "sid": "VDnRMDsXrMZ5nWmQ7tH6xw", "serverNonce": "c2VydmVyLW5vbmNlLTEyMw", "capabilities": ["content.clear", "state.speaking", "state.text"] }

  **Step 2 (Subscriber Proof):** The Subscriber generates a cryptographically random 16-byte client nonce and selects only capabilities it supports. It computes an HMAC digest using the dedicated handshake key derived from ${K}_{c}$ over the length-prefixed binary encoding of the literal `AACpipe-auth-v1`, connection ID, server nonce, client nonce, channel ID, the Publisher's offered capabilities, and the Subscriber's selected capabilities. Capability names are sorted by ascending UTF-8 byte value before encoding:  
  $proof=HMAC-SHA256({K}_{handshake},transcript)$

  The subscriber responds within 5 seconds with an AUTH\_RESPONSE frame:

```
JSON
{
    "v": 1,
    "type": "AUTH\_RESPONSE",
    "cid": "x7K9pL3mN2qR8TvQa",
    "sid": "VDnRMDsXrMZ5nWmQ7tH6xw",
    "clientNonce": "am9ZQmhxN1NqTTJQbW9Zdw",
    "capabilities": ["content.clear", "state.speaking", "state.text"],
    "proof": "8f3b2a1c...\[Base64URL HMAC Digest\]..."
  }
```

**Step 3 (Verification & Authorization):** The Publisher computes the expected HMAC.

If valid, the socket status upgrades to AUTHENTICATED and is moved into the active streaming pool for that cid. The negotiated capabilities are the intersection of those offered and selected, further restricted by the Publisher's authoritative channel permissions. `state.text` and `content.clear` are mandatory v0.1 capabilities; authentication fails as incompatible if either is not offered and selected. `state.speaking` is optional. Proofs are compared in constant time. A challenge is single-use, and the unauthenticated pending pool and failed attempts are rate-limited. An unsupported version or incompatible mandatory-capability set closes with 4002. An invalid proof, connection ID, capability selection, or timeout closes with 4003.

After authentication, the Publisher immediately sends a complete authoritative `STATE_UPDATE` snapshot. Reconnection and browser reload use the same handshake and snapshot process as an initial connection. The Subscriber never restores a previous message from local storage.

8. ### **Revocation & Key Invalidation Protocol**

> - **Revocation Payload Dispatch:** The Publisher transmits an encrypted control frame containing eventType: "SYSTEM\_REVOKED".
> - **Key Destruction and Tombstone:** The Publisher deletes ${K}_{c}$ and the active channel tuple, then persists a non-secret revocation tombstone containing at least the channel ID. This permits a previously paired but offline Subscriber to distinguish revocation from a temporary network failure without retaining the destroyed secret.
> - **Socket Termination:** The Publisher closes the active WebSocket connection with Close Code 4001 (Unauthorized / Revoked).
> - **Subscriber Credential Destruction:** Upon receiving the authenticated revocation event or a 4001 close response from the Publisher during a later authentication attempt, the Subscriber immediately wipes on-screen and in-memory message content, deletes the channel's persisted pairing record, stops reconnecting, and displays a locked status screen requiring a new QR code scan. If the Subscriber was offline during revocation, the Publisher matches its channel ID to the tombstone and rejects its next authentication attempt with 4001, causing the same local deletion. In the LOCAL profile, an active attacker can forge network failures or close responses; this denial-of-service risk is part of that profile's documented limitation.
> - **Clear Content — Not Revocation:** A `--clear` bridge command or the "Clear Channel Content" action clears the Publisher's current buffer and any retained content/history for that channel, then dispatches `CLEAR_BUFFER`. The Subscriber clears all displayed and in-memory content. The Publisher channel tuple, channel secret, Subscriber pairing record, authenticated socket, and permission settings remain valid. No new QR scan is required.
> - **Persistent Session Recovery:** Persistent channels survive Publisher restarts, browser reloads, browser restarts, tab closure, and transient disconnections. The Subscriber reconnects with its stored pairing credential, repeats authentication, and receives a fresh authoritative state snapshot. It never restores stale text locally. Only explicit revocation—or external deletion of browser site data—removes the persistent Subscriber credential.

9. ### **User Interface & Symbol Standards**

- **Responsive Distance Typography:** Text size must dynamically scale based on string length using viewport units or CSS clamp() to ensure readability from 2 to 6 feet away.
- **High Contrast Accessibility:** Minimum WCAG AAA contrast ratio compliance for both light (daylight outdoor) and dark (low light indoor) environments.
- **Extensible Token Pipeline:** While rendering is text-only initially, the Subscriber token parser supports future symbol ID mapping without breaking changes.
- **Partner Candidate Dock:** Future read-write partner UI controls may render as a discrete bottom sheet or side panel on the AAC interface to avoid obscuring primary vocabulary grids; this is not part of the initial read-only release.

  10. ### **Embedded Asset Serving (100% Offline)**

The AACpipe Publisher binary embeds all single-page app frontend assets (HTML, CSS, JS) directly inside the executable binary (e.g., via rust-embed in Rust, //go:embed in Go, or single-executable bundling in Node.js).

- When a partner scans the QR code, their phone requests the interface directly from the local HTTP daemon running on the AAC device.
- Internet Dependency: Zero. No CDN calls, no remote web servers, and no external tracking.

  11. ### **Local Networking & Connectivity Modes**

| Network Context             | Connection Setup                                                                                                  | Internet Required?                   |
| :-------------------------- | :---------------------------------------------------------------------------------------------------------------- | :----------------------------------- |
| **Home / Known Wi-Fi**      | Both AAC device and partner phone join the same Wi-Fi router. Direct HTTP/WebSocket streaming on local IP subnet. | **No** (Works 100% offline).         |
| **Outdoors / Mobile**       | AAC user enables Wi-Fi Hotspot on their device. Partner connects phone to the AAC Wi-Fi access point.             | **No** (Cellular data not required). |
| **School / Public Network** | If router AP Isolation blocks peer LAN traffic, AAC device prompts user to toggle Wi-Fi Hotspot mode.             | **No**.                              |

2. ## **AAC Application Integration (Command Bridge)**

The AAC application does not speak the AACpipe wire protocol. It invokes a short-lived local executable, the **Command Bridge**, once per user action. The bridge translates a single AAC event into a single Publisher command.

This keeps AACpipe decoupled from any particular AAC product: anything that can copy text to the clipboard and run a program can drive a partner screen.

1.  ### **Process Model**

| Role                   | Lifetime                                                | Responsibility                                                                                                                   |
| :--------------------- | :------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------- |
| **Resident Publisher** | Long-running, one instance per interactive Windows user | Owns the authoritative buffer, channel registry, keys, revision counter, HTTP/WebSocket server, mDNS advertisement, and tray UI. |
| **Command Bridge**     | Milliseconds, one process per AAC action                | Parses flags, reads the clipboard, sends one IPC command, reports an exit code, exits. Stateless.                                |

Both roles ship in a single `aacpipe.exe`. Running it with a command flag enters bridge mode; running it with `--host`, or from the Start Menu/startup shortcut, enters resident mode.

The Command Bridge is the **only** supported way for an AAC application to change the buffer in v0.1. The Publisher never scrapes, hooks, or reads the AAC application's UI.

2.  ### **Invocation Model**

A Grid 3 cell performs its normal AAC actions and then runs the bridge. A typical "add word" cell is:

1. Grid 3 writes the word to the message bar (existing behavior).
2. Grid 3 copies the relevant text to the clipboard.
3. Grid 3 runs `aacpipe.exe --word`.

The flag — not the clipboard content — determines how the text is interpreted. The same clipboard string means different things under `--word` and `--sentence`.

> **Console window suppression**: The bridge must be built as a Windows GUI-subsystem binary, or otherwise launched without allocating a console. A console window flashing on every selected word would be unacceptable for eye-gaze and switch users.

3.  ### **Command Set**

Exactly one content action (`--word`, `--sentence`, `--clear`) may be supplied per invocation. `--speak` may be supplied alone or after `--word` or `--sentence`. Management commands may not be combined with content commands.

| Command      | Reads clipboard | Effect on authoritative buffer                                                             | Resulting state                         |
| :----------- | :-------------- | :----------------------------------------------------------------------------------------- | :-------------------------------------- |
| `--word`     | Yes             | Appends the clipboard text to the existing buffer using the join rules below.              | COMPOSING                               |
| `--sentence` | Yes             | Replaces the entire buffer with the clipboard text. Authoritative resynchronisation point. | COMPOSING, or IDLE if the text is empty |
| `--clear`    | No              | Empties the buffer and discards retained channel content. Emits `CLEAR_BUFFER`.            | IDLE                                    |
| `--speak`    | No              | Leaves the buffer unchanged; marks the current message as being spoken.                    | SPEAKING                                |
| `--pair`     | No              | Creates a channel and displays its pairing QR code on the AAC screen.                      | unchanged                               |
| `--revoke`   | No              | Revokes a channel, destroying its credentials per the revocation protocol.                 | unchanged                               |
| `--status`   | No              | Reports Publisher health for diagnostics. Never prints buffer text or secrets.             | unchanged                               |

**Modifiers**

| Modifier                          | Applies to             | Meaning                                                                                                                                                              |
| :-------------------------------- | :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--text "<string>"`               | `--word`, `--sentence` | Supplies text directly instead of reading the clipboard. Intended for testing and for AAC applications that can pass arguments. Takes precedence over the clipboard. |
| `--persistent` / `--ephemeral`    | `--pair`               | Selects channel type. Defaults to `--ephemeral`.                                                                                                                     |
| `--label "<name>"`                | `--pair`               | Sets the human-readable channel label shown in the Publisher UI.                                                                                                     |
| `--channel <channelId>` / `--all` | `--revoke`             | Selects the channel to revoke. One is required.                                                                                                                      |
| `--timeout <ms>`                  | all                    | Overrides the bridge's total deadline. Default 1500 ms.                                                                                                              |

`--speak` sets SPEAKING for a configurable hold period (`speakHoldMs`, default 4000 ms), after which the Publisher reverts to COMPOSING, or to IDLE if the buffer is empty. Any subsequent content command also ends SPEAKING immediately. A dedicated `--speak-end` flag is reserved for a future release.

4.  ### **Buffer Semantics (Append-Only)**

The Publisher holds the authoritative buffer. The AAC application is not required to resend the whole message for every word.

**Word join rules for `--word`:**

- Leading and trailing whitespace in the supplied text is trimmed.
- If the trimmed text is empty, the command is a no-op and the revision does not change.
- If the buffer is empty, the buffer becomes the trimmed text.
- If the trimmed text begins with a character in the non-spacing set `. , ! ? ; : ' ’ ) ] } % ”` the text is appended with no separator.
- Otherwise, a single space separator is inserted before the text.
- If the buffer ends with an opening character in `( [ { ‘ “` the separator is suppressed.
- Runs of whitespace inside the result are collapsed to a single space; the buffer never starts with whitespace.

**Resynchronisation points.** `--sentence` and `--clear` replace the authoritative buffer outright. They are the only commands that correct accumulated divergence.

> **Accepted limitation — buffer drift**: Because appends are trusted, the partner screen reflects the sequence of bridge commands, not the live contents of the AAC message bar. If the AAC user deletes a word, edits text, or accepts a prediction without a corresponding bridge call, the partner screen will show stale or duplicated text until the next `--sentence` or `--clear`. This is an accepted v0.1 trade-off in exchange for a simple, low-latency integration.
>
> To limit how long divergence persists, any AAC cell that performs a non-append edit — delete word, delete letter, clear, accept prediction, recall a stored phrase — should send `--sentence` with the full message bar rather than `--word`. Speak cells should also send `--sentence` before `--speak`, so every spoken message starts from a known-correct state.

**Limits.** A single `--word` payload is limited to 256 bytes UTF-8. The authoritative buffer is limited to 4096 bytes UTF-8. Clipboard reads larger than 64 KiB are rejected without inspection. If an append would exceed the buffer limit, the Publisher discards the oldest text at a grapheme-cluster boundary, retains the most recent content, and sets the optional `buffer.truncated` flag in `STATE_UPDATE`.

**Update coalescing.** Accepting a bridge command and transmitting a `STATE_UPDATE` are separate steps. The Publisher increments the revision immediately, but applies a short configurable debounce (`updateIntervalMs`, default 50 ms) before sending. If several commands arrive inside that window, or if a Subscriber socket is applying backpressure, the Publisher discards superseded snapshots and sends only the newest buffer state. Because every `STATE_UPDATE` is a complete snapshot, dropping intermediate frames is always safe. `CLEAR_BUFFER` and `SYSTEM_REVOKED` are never debounced or dropped, so content always disappears from the partner screen at the earliest opportunity.

5.  ### **Clipboard Acquisition**

The clipboard is shared, mutable global state, so the bridge treats it defensively.

- **Format:** `CF_UNICODETEXT` only. The bridge must not paste images, files, or rich text.
- **Timing race:** The AAC application sets the clipboard and launches the bridge as separate steps, and the clipboard may be locked by another process. The bridge retries `OpenClipboard` for up to 500 ms (for example 20 attempts at 25 ms) before failing.
- **Validation:** Content must be valid UTF-16 convertible to UTF-8. `CR LF` and lone `CR` are normalised to `LF`. Control characters other than `LF` and `TAB` are stripped.
- **Empty or non-text clipboard:** `--word` and `--sentence` fail with a distinct exit code and leave the buffer unchanged. A failed read must never be interpreted as "clear".
- **No mutation:** The bridge never writes to, clears, or restores the clipboard. Other AAC workflows depend on it.

> **Privacy note**: Routing message text through the system clipboard means any other application running as the same user can read it. This is inherent to the integration method, not something AACpipe can prevent. It is acceptable because the AAC application already places this text on the clipboard, but it should be stated plainly to users and deployers.

6.  ### **Local IPC Transport**

- **Channel:** A Windows named pipe, message mode, named per user — for example `\\.\pipe\aacpipe.v1.{userSidHash}`.
- **Access control:** The pipe DACL grants access only to the SID of the user that created it. The pipe is created with `PIPE_REJECT_REMOTE_CLIENTS` so it cannot be reached over SMB from another machine.
- **Framing:** One UTF-8 JSON request terminated by `LF`, then one UTF-8 JSON response terminated by `LF`. Complete request or response frames above 128 KiB are rejected. This leaves room for the JSON envelope around the maximum 64 KiB sentence text.
- **Correlation:** Every request contains an `id` of 1–64 ASCII letters, digits, `_`, or `-`. The response echoes the same `id`. Although v0.1 uses one request per connection, the identifier makes timeout diagnostics unambiguous and permits future connection reuse without changing the schema.
- **Deadline:** The bridge abandons the attempt and exits non-zero once its total timeout elapses, so a wedged Publisher can never block the AAC application.

Example request and response:

```
{"v":1,"id":"grid3-106","cmd":"word","text":"water"}
{"v":1,"id":"grid3-106","ok":true,"state":"COMPOSING","revision":"106","channels":1,"subscribers":1}
```

The IPC schema is internal to the product and versioned by its own `v` field. It is deliberately separate from the wire protocol: changing the bridge does not change what Subscribers parse.

7.  ### **Publisher Auto-Start**

If the bridge cannot connect because the pipe does not exist:

1. It acquires a named single-start mutex so that several rapid invocations cannot launch competing Publishers.
2. It starts the resident Publisher detached, with no visible window.
3. It waits for the pipe to appear, polling until its deadline expires.
4. It then delivers the original command, so the triggering word or sentence is not lost.

The resident Publisher itself enforces single-instance behavior with a per-user mutex, and exits immediately if another instance already owns it.

Auto-start only makes the Publisher available; it does not create, restore, or reconnect channels, and it never transmits to an unpaired device. A persistent Subscriber reconnects on its own once the Publisher is listening again.

8.  ### **Exit Codes**

| Code | Meaning                                                                                       |
| :--- | :-------------------------------------------------------------------------------------------- |
| 0    | Command accepted by the Publisher.                                                            |
| 2    | Invalid or conflicting arguments.                                                             |
| 3    | Clipboard unavailable, empty, or not text.                                                    |
| 4    | Publisher unavailable and auto-start failed within the deadline.                              |
| 5    | Payload rejected: too large or failed validation.                                             |
| 6    | Command valid but refused by the Publisher, for example `--revoke` naming an unknown channel. |
| 1    | Any other failure.                                                                            |

Having no paired channel is **not** an error. The buffer still updates and the command returns 0, so partner-screen pairing can start mid-sentence.

9.  ### **Latency Budget**

A `--word` invocation occurs on the AAC user's critical path and should complete within roughly 100 ms, including process start, clipboard read, and IPC round trip.

> **Implementation risk**: Process startup dominates this budget. A Node.js single-file executable typically starts in tens of milliseconds and may exceed the budget on lower-powered AAC hardware, especially with on-access antivirus scanning. Measure bridge startup on representative hardware early. If the budget cannot be met, implement the bridge as a small native executable while keeping the resident Publisher in TypeScript/Node.js; the IPC contract above makes that substitution possible without protocol changes.

The bridge must never block on network activity. It returns as soon as the Publisher acknowledges the command; encryption and WebSocket delivery happen asynchronously in the resident process.

10. ### **Trust Model for Local Commands**

Any process running as the same Windows user can invoke the bridge or write to the pipe, and can therefore place arbitrary text on the partner screen. AACpipe treats the local interactive user as trusted and relies on Windows user isolation for this boundary; the pipe DACL prevents access by _other_ users and by remote machines.

As hardening, the Publisher should rate-limit commands, validate every field against the documented limits, and ignore malformed requests rather than resetting the buffer. Verifying the calling process image path is a reasonable future addition but is not a security guarantee.

11. ### **Grid 3 Cell Design Guidance**

| Grid 3 cell                 | Recommended command sequence                                                                      |
| :-------------------------- | :------------------------------------------------------------------------------------------------ |
| Word / symbol tile          | Existing write action → copy word → `aacpipe.exe --word`                                          |
| Letter or keyboard key      | Prefer copying the whole message bar → `aacpipe.exe --sentence`                                   |
| Delete word / delete letter | Copy whole message bar → `aacpipe.exe --sentence`                                                 |
| Prediction accepted         | Copy whole message bar → `aacpipe.exe --sentence`                                                 |
| Speak                       | Copy whole message bar → `aacpipe.exe --sentence` → `aacpipe.exe --speak` → existing Speak action |
| Clear message bar           | `aacpipe.exe --clear` → existing Clear action                                                     |
| Pair a partner screen       | `aacpipe.exe --pair --ephemeral` or `--pair --persistent --label "Mum"`                           |
| Stop sharing                | `aacpipe.exe --revoke --all`                                                                      |

Character-by-character typing should not send a bridge command per keystroke. Either send `--sentence` on word completion, or rely on the Publisher's update coalescing described above.

12. ### **Extensibility to Other AAC Software**

The command vocabulary is deliberately product-neutral. Supporting another AAC application requires only that it can run a program with a flag, and the `--text` modifier already allows integrations that pass text as an argument instead of via the clipboard.

Future write-capable releases may add bridge commands that surface partner suggestions to the AAC user. Those commands would remain subject to the AAC agency rules: suggestions arrive in a separate candidate dock and never enter the buffer without explicit user activation.

3. ## **Protocol Message Schemas**
   1. ### **Unencrypted Handshake Frames (Handshake Phase)**

- **Publisher Challenge:**

```
  JSON
  { "v": 1, "type": "CHALLENGE", "sid": "VDnRMDsXrMZ5nWmQ7tH6xw", "serverNonce": "c2VydmVyLW5vbmNlLTEyMw", "capabilities": ["content.clear", "state.speaking", "state.text"] }
```

- **Subscriber Auth Response:**

```
  JSON
  {
    "v": 1,
    "type": "AUTH\_RESPONSE",
    "cid": "x7K9pL3mN2qR8TvQa",
    "sid": "VDnRMDsXrMZ5nWmQ7tH6xw",
    "clientNonce": "am9ZQmhxN1NqTTJQbW9Zdw",
    "capabilities": ["content.clear", "state.speaking", "state.text"],
    "proof": "eFpLdW13OThzZE40..."
  }
```

2. ### **Encrypted Data Frame (Authenticated Phase)**

Transmitted directly over the local WebSocket connection (ws://aacpipe.local:8080), Transmitted strictly to authenticated sockets assigned to `cid` :

```
JSON
{
  "v": 1,
  "cid": "x7K9pL3mN2qR8TvQa",
  "sid": "VDnRMDsXrMZ5nWmQ7tH6xw",
  "seq": "104",
  "tag": "MTIzNDU2Nzg5MGFiY2RlZg",
  "payload": "a1B2eFpL...\[Base64 AES-256-GCM Encrypted Payload\]..."
}
```

3. ### **Decrypted State Update Payload (Publisher \-\> Subscriber)**

`STATE_UPDATE` is a complete authoritative snapshot, including immediately after initial authentication or reconnection. It is optimized for immediate text display and extensible to future symbol support. The Subscriber may display it only while the channel remains authenticated:

```
JSON
{
  "ts": 1718000520120,
  "eventType": "STATE\_UPDATE",
  "revision": "104",
  "state": "COMPOSING",
  "buffer": { "text": "Hello", "truncated": false },
  "meta": {
    "channelLabel": "Mom",
    "battery": 82
  }
}
```

4. ### **System Revocation Event (Publisher \-\> Subscriber)**

```
   JSON

   {

     "ts": 1718000529000,

     "eventType": "SYSTEM\_REVOKED",

     "reason": "USER\_MANUAL\_REVOKE"

   }
```

5. ### **Clear Buffer / Clear Channel Data Event (Publisher \-\-\> Subscriber)**

```
   JSON

   {

     "ts": 1718000529400,

     "eventType": "CLEAR\_BUFFER",

     "reason": "USER\_CLEARED\_MESSAGE\_BAR",

     "revision": "105",

     "cid": "x7K9pL3mN2qR8TvQa"

   }
```

`CLEAR_BUFFER` is a content-lifecycle event, not a credential-lifecycle event. On receipt, the Subscriber clears the rendered message and any in-memory content derived from the channel. It must retain the pairing credential and remain connected. `SYSTEM_REVOKED` is the only v0.1 event that invalidates a persistent pairing.

6. ### **Versioning, Revisions, and Extension Rules**

- `v` is the protocol major version. v0.1 uses wire major version `1`. A peer that does not support the offered major version closes with private Close Code 4002 (Unsupported Protocol).
- New optional JSON fields may be added within wire version 1. Receivers ignore unknown optional fields but reject a message that omits a required field, violates a field type or limit, or uses an unknown value where safe handling is not defined.
- New optional behavior is enabled only through an authenticated capability name. Receiving an event for a capability that was not negotiated is a protocol error; the receiver clears any displayed content and closes the socket.
- `seq` and `revision` are encoded in JSON as canonical unsigned 64-bit decimal strings matching `0|[1-9][0-9]*`, with no sign or leading zeroes. Implementations reject values greater than `18446744073709551615`. This avoids precision loss in JavaScript.
- `revision` is the Publisher's unsigned, monotonically increasing logical content revision for a channel. It increments whenever the current composition state changes or content is cleared. Persistent channels persist their latest revision across Publisher restarts; ephemeral channels retain it only for their lifetime. It is distinct from the per-connection encrypted-frame `seq`.
- `buffer.text` is required under the `state.text` capability and is limited to 4096 bytes UTF-8. `buffer.truncated` is an optional boolean, defaulting to `false`, set when the Publisher discarded older text to stay within that limit. Subscribers that ignore it still render correct current text.
- `ts` is Unix time in milliseconds for display and diagnostics only. It is not used for authentication, ordering, replay protection, or expiry.
- A `STATE_UPDATE` is always a complete snapshot for its revision. This permits reconnection and future clients to recover without applying or retaining a history of text patches.
- Mandatory v0.1 capability names are `state.text` and `content.clear`; `state.speaking` is optional. Future examples include `symbols.render`, `suggestions.submit`, and `suggestions.feedback`; defining or negotiating a capability does not grant permission to use it. Channel permissions remain authoritative.

4. ## **Possible Protocol Extensions**

> **v0.1 scope note**: The following features are future extensions and are not part of the initial Windows + Grid 3 read-only release. The protocol is intentionally structured to support them without breaking the base wire format.

1.  ### **Partner Suggestions**

In accordance with human-computer interaction (HCI) standards in AAC, partner suggestions must **never automatically overwrite, auto-complete, or hijack the AAC user's active composition buffer**.

> 1. **Isolated Suggestion Tray:** When a partner sends a PARTNER\_SUGGESTION payload over a local Read-Write WebSocket connection, the AAC Publisher routes the suggestions to a dedicated candidate dock on the AAC screen without altering the typing area.
> 2. **Explicit User Confirmation:** The suggestion is appended to the main buffer only when the AAC user explicitly activates it via touch, eye-gaze dwell, or switch scanning.
> 3. **Feedback Loop:** Acceptance or rejection of suggestions dispatches a SUGGESTION\_FEEDBACK frame to notify the partner application, enabling real-time visual UI cues.

1.  #### **Partner Suggestion Payload (Subscriber \-\> Publisher)**

Sent over collaborative (prm: "rw") channels to suggest completions or predictions without altering the user's buffer directly:

```
JSON
{
  "ts": 1718000525000,
  "eventType": "PARTNER\_SUGGESTION",
  "cid": "x7K9pL3mN2qR8TvQa",
  "suggestions": \[
    {
      "id": "sug\_01",
      "text": "sparkling water",
      "type": "COMPLETION",
      "confidence": 0.90
    }
  \]
}
```

2. #### **Suggestion Feedback Payload (Publisher \-\> Subscriber)**

```
   JSON

   {
     "ts": 1718000526100,
     "eventType": "SUGGESTION\_FEEDBACK",
     "cid": "x7K9pL3mN2qR8TvQa",
     "suggestionId": "sug\_01",
     "action": "ACCEPTED"
   }
```

3.  #### **Additional Event Types**

| Event Type (eventType) | Direction              | Purpose / Trigger                                                                     |
| :--------------------- | :--------------------- | :------------------------------------------------------------------------------------ |
| PARTNER\_SUGGESTION    | Subscriber → Publisher | Submits word completions, predictions, or contextual hints from a read-write partner. |
| SUGGESTION\_FEEDBACK   | Publisher → Subscriber | Reports AAC user action (ACCEPTED, REJECTED, EXPIRED) on partner suggestions.         |

2.  ### **Graphic Symbol Support**

Initially the protocol will be used to transmit and render text, but this can be extended to include symbol support.

- **Subscriber UI:** Renders high-visibility, large-format distance typography derived from buffer.text.
- **Payload Extensibility:** A future `symbols.render` capability may add an optional `tokens` array to `STATE_UPDATE`. Tokens can carry fallback text and an optional symbol-set-qualified ID. Subscribers that do not negotiate symbol support continue to render `buffer.text`, so adding symbols does not alter the protocol envelope or break text-only clients.

  # **Reference Host Implementation (Node.js/TypeScript)**

To be added. It should demonstrate, at minimum:

- Resident Publisher: embedded SPA asset serving, mDNS advertisement with a collision-resistant per-Publisher hostname, channel registry, and the authenticated WebSocket pipeline.
- Command Bridge: flag parsing, defensive clipboard acquisition, named-pipe IPC with a per-user DACL and `PIPE_REJECT_REMOTE_CLIENTS`, Publisher auto-start, and the documented exit codes.
- Shared: HKDF key derivation, deterministic IV construction, associated-data encoding, and runtime schema validation, together with the cross-implementation test vectors required before any interoperability milestone.

A measured bridge startup time on representative AAC hardware should be recorded here, since it determines whether the bridge can remain a Node.js binary or must be rewritten natively.
