# AACpipe Protocol Specification

**Status:** Design draft, revision 0.2; not an implemented or frozen standard

**Wire major version:** 2

**Audience:** Independent AAC application, partner application and device implementers

**Updated:** 2026-10-22

> This document describes a proposed wire-2 protocol. The current Windows/Grid 3
> preview implements legacy wire 1, not this draft. Editing this specification
> does not upgrade that implementation. See Appendix B for known differences.
> Independent interoperability, fixed test vectors and physical-device testing
> are release gates, not claims made by this document.

## 1. Purpose, scope and conformance

AACpipe connects an AAC user's authoritative composition to a communication
partner's application or device. It supports live partner displays and optional
partner contributions without transferring control of the AAC user's message.

The protocol defines observable messages and behaviour. It does not require a
particular operating system, programming language, application architecture,
AAC product, user interface, executable, clipboard integration or storage API.
A Publisher may be part of an AAC application, a separate service or a hardware
device. A Subscriber may be a browser, native application or dedicated receiver.

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** describe
requirements. SHOULD-level deviations require a documented reason. Sections
1-12 are normative draft requirements; Appendices A-C are informative.

### 1.1 Specification layers

| Layer | Defines |
| --- | --- |
| Core | Authority, channels, credentials, sessions, content lifecycle, negotiation and extension rules. |
| Transport profile | Discovery, pairing, endpoint, framing, authentication, liveness and transport-specific errors. |
| Application profile | A useful interoperable role, with mandatory capabilities and limits. |
| Optional capability | Additional messages and behaviour, enabled only by negotiation and authorization. |
| Implementation guidance | Examples of integrations, storage, rendering and packaging; not conformance requirements. |

This draft defines the `local-websocket-v2` transport, `text-display` and
`suggestions-partner` application profiles, and the capabilities in sections 8-9.
A conformance claim MUST identify wire major, transport profile, application
profile(s), role and implemented capabilities. "AACpipe compatible" without
that information is insufficient.

A text-display peer need not implement suggestions. A suggestions-only partner
need not render or receive composition text. Other transports and profiles MAY
be specified separately, but are not automatically interoperable with this one.
Internet relays and authenticated HTTPS bootstrap are not defined by this draft.

### 1.2 Fundamental requirements

- The Publisher is authoritative for each channel's composition and permissions.
- A partner suggestion MUST NOT modify composition, trigger speech or invoke
  AAC commands without the AAC user's explicit action through the AAC interface.
- Content clearing, credential revocation and local forgetting are distinct.
- Recoverable state MUST be distinguishable from actions with side effects.
- Failure, unsupported features and unavailable persistence MUST be surfaced;
  implementations MUST NOT silently claim a capability or guarantee they lack.
- The defined local transport MUST operate without an internet connection,
  external account, remote asset download, analytics or cloud service.

## 2. Roles and object model

| Term | Meaning |
| --- | --- |
| AAC user | The person whose composition is shared and who controls authorization. |
| Publisher | The authority for channel state, partner authorization and accepted suggestions. |
| Subscriber | An authenticated partner peer; its name does not imply content-read-only access. |
| Channel (`cid`) | A logical sharing context with its own authoritative view and lifecycle. |
| Credential (`kid`) | A revocable pairing secret and its policy, belonging to one channel. |
| Session (`sid`) | One authenticated connection using a credential; never a durable pairing. |
| Generation (`generation`) | A content-lifecycle identifier delimiting which state, suggestions and actions remain applicable. |
| Revision (`revision`) | A content-state counter within one channel generation, distinct from frame sequence. |

Channels MAY mirror a common AAC source or expose different views. They need
not use separate internal buffers, processes or databases. Revisions from
different channels are not comparable.

Clearing a channel affects that channel's shared content, not necessarily the
AAC application's source message or other channels. A Publisher MAY offer a
user action that clears several channels; it MUST apply each channel's clear
barrier independently. Its interface MUST explain the scope.

A channel MAY have multiple independently revocable credentials. Sharing one
credential between partners does not create independently identifiable partners.
Each credential permits **one active session** in this profile. A second
connection MUST first authenticate; if an active session still exists, the
Publisher MUST reject the new session as busy without displacing the old one.
Unauthenticated connections MUST NOT reserve the active-session slot.

Labels are optional display metadata, not identity, routing keys or authority.
Publishers MAY choose their own label uniqueness and localization policies.

### 2.1 Credential lifetime

- **Persistent (`p`):** Stored until explicit revocation, local forgetting or
  external loss of storage. Normal reload, restart and network loss do not
  revoke it. Reconnection requires fresh session authentication.
- **Temporary (`e`):** Not persisted. Ends when its first authenticated session
  disconnects, the Publisher exits, or the AAC user revokes it. There is no
  reconnect grace period in this profile. Failed or unauthenticated connection
  attempts MUST NOT consume it.

An unclaimed temporary credential MAY have a Publisher-local expiry. It MUST
NOT expire merely because the AAC user pauses composition while its session is
healthy. A separate future extension may define explicit reconnect leases.

Revoking a credential MUST disconnect its sessions and prevent later use.
Closing a channel MUST revoke all its credentials and discard channel content.
Deleting a Subscriber's local pairing record does not revoke the Publisher's
credential. Publishers SHOULD provide an AAC-user-controlled revocation method.

## 3. Common encoding and bounds

All protocol messages are UTF-8 JSON objects. Duplicate object member names,
invalid UTF-8, unpaired Unicode surrogates and non-finite numbers are invalid.
JSON whitespace and object member order have no semantic significance.
Cryptographic transcripts use the binary encoding in section 6, not JSON
serialization or a library's default object ordering.

Every handshake, encrypted envelope and decrypted event contains `"v": 2`.
Handshake messages use `type`; encrypted events use `eventType`.

| Field/type | Encoding and limit |
| --- | --- |
| `cid`, `kid`, `sid`, `generation`, `eventId`, `submissionId`, `suggestionId` | Independent CSPRNG-generated 16-byte identifiers, canonical unpadded Base64URL, exactly 22 characters. IDs are opaque, case-sensitive and not secrets. |
| Channel credential secret | 32 CSPRNG bytes, canonical unpadded Base64URL, exactly 43 characters. |
| Handshake nonces | 16 CSPRNG bytes, canonical unpadded Base64URL, exactly 22 characters. |
| HMAC proof | 32 bytes, canonical unpadded Base64URL, exactly 43 characters. |
| GCM tag | 16 bytes, canonical unpadded Base64URL, exactly 22 characters. |
| `seq`, `revision` | Unsigned 64-bit canonical decimal strings: `0` or a nonzero digit followed by digits; maximum `18446744073709551615`. |
| `ts` | Optional Unix milliseconds, integer 0 through `9007199254740991`; diagnostic only. |
| Capability, profile, permission or reason name | ASCII `[a-z][a-z0-9.-]*`, 1-96 bytes. |
| Name lists | At most 32 distinct names; duplicates invalid. |
| Label | At most 256 UTF-8 bytes. |
| JSON nesting | At most 16 container levels, counting the outer object as level 1. |

Base64URL uses `A-Z`, `a-z`, `0-9`, `-`, `_`, without padding. Decoders MUST
reject invalid lengths, nonzero unused trailing bits and noncanonical encodings.

One WebSocket text message carries one JSON frame. Its UTF-8 size MUST NOT
exceed 65536 bytes. The same limit applies to decrypted JSON; handshake JSON
is limited to 8192 bytes. Binary messages are unsupported. Limits include
unknown fields; implementations MUST bound input before expensive processing.

Unknown optional object fields MUST be ignored, subject to these bounds.
Unknown enum values, missing required fields and invalid field types MUST NOT
be guessed or silently substituted. An unknown event type is an error unless
a negotiated extension explicitly defines how to handle it.

`ts` MUST NOT determine order, replay acceptance, authorization or expiry.
Peers need not have synchronized clocks.

## 4. Application profiles, capabilities and permissions

The core includes session confirmation, heartbeat, errors, content clearing
and revocation. These are not optional capabilities.

| Application profile | Required active capabilities | Purpose |
| --- | --- | --- |
| `text-display` | `state.text` | Receives complete textual composition snapshots. |
| `suggestions-partner` | `suggestions.submit`, `suggestions.feedback` | Submits independent text candidates and receives lifecycle feedback; no composition-text access implied. |

A Subscriber requests one or both profiles. The Publisher MUST activate every
requested profile or reject the session as incompatible/unauthorized; it MUST
NOT silently substitute a different role.

### 4.1 Negotiation is not authorization

- **Offered:** The Publisher implements and offers a capability.
- **Requested:** The Subscriber implements and asks to activate it.
- **Granted:** Credential policy and AAC-user consent permit its use.
- **Active:** The Publisher has confirmed it for this session.

The requested list MUST be a subset of the offered list. The active list MUST
be a subset of the requested list and MUST satisfy requested profiles.
Optional requests MAY be declined. All three lists are distinct protocol
concepts; absence of a capability means it is inactive.

Permissions are separate from implementation support:

| Permission | Authorizes |
| --- | --- |
| `composition.read` | Receipt of shared composition text. |
| `suggestions.submit` | Submission of candidates for AAC-user consideration. |

`state.text`, `state.speaking` and `action.notify` require `composition.read`.
`state.speaking` and `action.notify` additionally depend on `state.text`.
The two suggestions capabilities require `suggestions.submit` and MUST be
activated together. A credential may grant both permissions, either, or neither;
an application profile still requires its corresponding permission.

There is no generic `rw` permission. No permission in this draft authorizes
direct edits, forced speech or arbitrary AAC commands. Local receiver opt-in
for sound is separate from channel authorization.

Changing effective permissions or active capabilities requires closing the
session and renegotiating. Revoked access MUST NOT wait for voluntary reconnect.

## 5. Local WebSocket transport and pairing

### 5.1 Endpoint and discovery

The `local-websocket-v2` profile uses HTTP and WebSocket on a trusted local
network or device hotspot. The WebSocket endpoint is:

```text
ws://{host}:{port}/aacpipe/v2?channel={cid}&credential={kid}
```

Exactly one `channel` and one `credential` query parameter are required.
Other query parameters are reserved and MUST be rejected in this version.
The secret MUST NOT appear in the query, path, HTTP headers or discovery data.
The host may be a local DNS/mDNS name, IPv4 address or bracketed IPv6 address.
No port is mandatory; an explicit port is used in pairing examples.

An optional browser receiver is served at `/`. Its pairing URL is:

```text
http://{host}:{port}/?channel={cid}&credential={kid}#2:{lifetime}:{cid}:{kid}:{secret}
```

`lifetime` is `p` or `e`. The fragment's version, IDs and lifetime MUST be
validated; the fragment IDs MUST match the query. Lifetime is a hint, not a
permission grant. The Publisher confirms authoritative policy after
authentication. A non-browser peer MAY receive the same pairing fields through
another trusted local mechanism without downloading a webpage.

A browser MUST remove the fragment with history replacement as soon as it has
validated and imported it, without navigating or reloading. The query IDs
remain so the browser can select a stored credential after reload. If a hint
conflicts with confirmed lifetime, temporary policy takes precedence: remove
any persisted copy and require a new persistent pairing if persistence is desired.

If a Publisher offers zero-install browser pairing it MUST serve all required
assets locally, without remote dependencies. How those assets are packaged is
not specified.

mDNS advertisement is OPTIONAL. An advertising Publisher uses
`_aacpipe._tcp.local`, its listener's actual port and TXT `v=2`, `path=/aacpipe/v2`.
Advertisements MUST NOT contain credentials, channel IDs, labels or content.
Stable collision-resistant hostnames are RECOMMENDED for browser persistence.
IP fallbacks are permitted. Discovery is neither identity nor authorization.

### 5.2 Storage and deployment trust

Persistent pairings MUST use platform-appropriate protected storage where
available. The wire protocol does not prescribe a storage API. If durable
storage is unavailable, the Subscriber MUST warn that this device will require
pairing again; it MUST NOT silently claim persistent local storage.

Browser credentials are origin-scoped. Switching between an IP address and a
hostname may require pairing again. Site-data eviction/private browsing can
lose credentials without revoking them at the Publisher.

**LOCAL trust limitation:** After authentic software has loaded, application
authentication and encryption limit passive content observation and access
without a credential. HTTP does not authenticate downloaded code. An active
network attacker can replace that code, steal the credential, forge traffic
or disrupt pairing. A shared network is not necessarily a trusted network.
Use only a trusted private network or the AAC device's own trusted hotspot.
This profile does not claim forward secrecy or protection after secret theft.

An authenticated HTTPS/WSS profile is reserved, not specified here. A future
profile MUST define trusted bootstrap, Publisher identity and downgrade rules;
changing URL schemes alone is insufficient. Peers MUST NOT automatically
downgrade a stored stronger transport profile to LOCAL.

## 6. Authentication and encrypted framing

This section defines the proposed `psk-aes256gcm-hkdfsha256-v2` suite. It uses
standard primitives but is a draft protocol construction, not a claim of
independent cryptographic review. Section 12's review and vector gates apply.
No alternative algorithm negotiation is defined in this transport version.

### 6.1 Binary encoding

- `UTF8(s)` is the UTF-8 encoding of the exact string, without normalization.
- `U32(n)` and `U64(n)` are unsigned 4-/8-byte integers in network byte order.
- `LP(b) = U32(byteLength(b)) || b`.
- `T(b1,...,bn) = LP(b1) || ... || LP(bn)`.
- `L(names) = U32(count) || LP(UTF8(name1)) || ... || LP(UTF8(nameN))`,
  after sorting unique ASCII names by ascending byte value.
- `B(field)` decodes a canonical Base64URL field to bytes.

All transcript inputs below are bytes; literal strings mean UTF-8 bytes.
List counts are part of the encoding, so adjacent lists cannot be confused.
Decimal-string counters are parsed as unsigned integers before U64 encoding.

### 6.2 Handshake

1. The Publisher sends `CHALLENGE` with fresh `sid` and `serverNonce`,
   offered capabilities and supported application profiles.
2. The Subscriber sends `AUTH_RESPONSE` within 10000 ms after the challenge,
   with a fresh `clientNonce`, requested profiles/capabilities and proof.
3. The Publisher verifies identity, proof and policy, then atomically claims
   the credential's active-session slot. A busy credential is rejected only
   after proof verification.
4. The first encrypted Publisher event is `SESSION_OPEN` with sequence zero.
   The Subscriber MUST NOT consider itself authenticated before verifying it.
   Active capabilities and grants become authoritative only then.
5. A text session receives a fresh `STATE_UPDATE` immediately afterwards.
   No historical action or suggestion is replayed.

The connection moves through pending, proof-verified, active and closed states.
Each challenge is single-use; another handshake message after activation is
invalid. Content MUST NOT be sent before activation. A failed proof or malformed
response closes the connection; it MUST NOT be retried on the same challenge.

Example handshake fields (identifiers and proof are illustrative, not a vector):

```json
{
  "v": 2,
  "type": "CHALLENGE",
  "sid": "AAAAAAAAAAAAAAAAAAAAAA",
  "serverNonce": "AQEBAQEBAQEBAQEBAQEBAQ",
  "profiles": ["text-display", "suggestions-partner"],
  "capabilities": ["state.text", "state.speaking", "action.notify", "suggestions.submit", "suggestions.feedback"]
}
```

```json
{
  "v": 2,
  "type": "AUTH_RESPONSE",
  "cid": "AgICAgICAgICAgICAgICAg",
  "kid": "AwMDAwMDAwMDAwMDAwMDAw",
  "sid": "AAAAAAAAAAAAAAAAAAAAAA",
  "clientNonce": "BAQEBAQEBAQEBAQEBAQEBA",
  "profiles": ["text-display"],
  "capabilities": ["state.text", "state.speaking"],
  "proof": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}
```

Derive `handshakeKey` with HKDF-SHA-256 (32-byte output):

```text
salt = SHA256(T("AACpipe-handshake-v2", B(cid), B(kid), B(sid), B(serverNonce)))
info = T("AACpipe-v2", "handshake")
handshakeKey = HKDF(secretBytes, salt, info, 32)
authTranscript = T(
  "AACpipe-auth-v2", B(cid), B(kid), B(sid),
  B(serverNonce), B(clientNonce),
  L(offeredProfiles), L(offeredCapabilities),
  L(requestedProfiles), L(requestedCapabilities)
)
proof = HMAC-SHA256(handshakeKey, authTranscript)
```

HKDF arguments above are input key material, salt, info and output length.
The Publisher MUST verify requested subsets and compare proofs in constant
time. The endpoint `cid`/`kid`, response IDs and challenge `sid` MUST match.

### 6.3 Traffic keys and envelopes

For each direction `d`, exactly `publisher-to-subscriber` or
`subscriber-to-publisher`:

```text
trafficSalt = SHA256(authTranscript)
trafficKey[d] = HKDF(secretBytes, trafficSalt, T("AACpipe-v2", "traffic", d), 32)
noncePrefix[d] = HKDF(secretBytes, trafficSalt, T("AACpipe-v2", "nonce", d), 4)
IV = noncePrefix[d] || U64(seq)
AAD = T("AACpipe-frame-v2", B(cid), B(kid), B(sid), d, U64(seq))
```

AES-256-GCM encrypts the exact UTF-8 event JSON with that IV and AAD, using a
128-bit tag. `payload` contains ciphertext only; `tag` contains the separate
tag. Both are unpadded Base64URL.

```json
{
  "v": 2,
  "cid": "AgICAgICAgICAgICAgICAg",
  "kid": "AwMDAwMDAwMDAwMDAwMDAw",
  "sid": "AAAAAAAAAAAAAAAAAAAAAA",
  "seq": "0",
  "payload": "AA",
  "tag": "AAAAAAAAAAAAAAAAAAAAAA"
}
```

This is a structural example, not valid ciphertext for an event.
Both the decrypted-size bound and the encoded envelope-size bound apply;
Base64URL expansion does not permit exceeding the outer frame limit.

Each direction starts at sequence zero and MUST receive exactly the next
sequence, without gaps, duplicates or reordering. Sequence numbers are assigned
when transmitting, after snapshot coalescing. Sender and receiver MUST verify
all envelope IDs, version, lengths and bounds. Invalid tags or sequences close
the connection. A key/IV pair MUST never be reused. Before sequence exhaustion,
close and perform a fresh handshake; do not wrap the counter.

The first Subscriber encrypted event may be a heartbeat acknowledgement or
another permitted core/active-capability event, with its own sequence zero.
An authenticated Publisher confirmation is provided by the encrypted
`SESSION_OPEN`; it is not proof of trusted HTTP bootstrap.

## 7. Core events and session lifecycle

Unless stated otherwise, fields in event definitions are required. `ts` is
optional on every event. Each event also requires `v` and `eventType`.
Direction abbreviations: P = Publisher, S = Subscriber.

### 7.1 SESSION_OPEN (P to S)

```json
{
  "v": 2,
  "eventType": "SESSION_OPEN",
  "profiles": ["text-display"],
  "capabilities": ["state.text", "state.speaking"],
  "permissions": ["composition.read"],
  "lifetime": "p",
  "generation": "BQUFBQUFBQUFBQUFBQUFBQ",
  "revision": "0",
  "heartbeatIntervalMs": 10000,
  "livenessTimeoutMs": 30000,
  "channelLabel": "Partner"
}
```

`channelLabel` is optional. Heartbeat values are fixed at 10000 and 30000 for
this transport version; they are confirmed, not freely negotiated. Profiles,
capabilities and permissions are unique name lists. Invalid or contradictory
grants are a protocol error. Even a suggestions-only peer receives content
generation/revision context, but not composition text without read permission.

### 7.2 Liveness (P to S and S to P)

Every 10000 ms, the Publisher sends encrypted `HEARTBEAT` containing current
`generation` and `revision`, even if composition has not changed. A Subscriber
answers with `HEARTBEAT_ACK` and `heartbeatSeq`, the sequence of the received
Publisher envelope. No content or permissions are conveyed by the ACK.
The Publisher accepts only an ACK for a sent heartbeat, once, within the
30000 ms liveness window.
Heartbeat context MUST reflect the Publisher's state at its transmission point
in the ordered event stream. Its generation MUST match the latest announced
generation, and its revision MUST NOT decrease within that generation.
It provides context, not a replacement composition snapshot.

The Subscriber clears content and closes if it has received no valid
authenticated Publisher event for 30000 ms. The Publisher closes if no valid
heartbeat ACK has arrived for 30000 ms, measured initially from session
activation. Timeouts use local monotonic elapsed time.

WebSocket ping/pong MAY supplement this mechanism but does not replace it:
browser JavaScript cannot directly observe those control frames. Other traffic
does not excuse the Publisher from sending heartbeats.

On detected disconnect, failed authentication, liveness expiry or suspension
that prevents reliable freshness monitoring, the Subscriber MUST immediately
remove shared content and cancel pending content-derived actions. A resumed
Subscriber MUST clear before rendering, reconnect and obtain fresh state.
This is a detection requirement, not a promise to execute code while a device
or browser is suspended.

Persistent Subscribers SHOULD reconnect with exponential backoff and jitter
(initial delay 500 ms, maximum 30000 ms recommended). Busy is retryable.
Temporary Subscribers MUST discard their credential on authenticated session
loss. They MUST NOT reconnect automatically with it.

### 7.3 CLEAR_BUFFER (P to S)

Required fields: `generation`, `revision` (always `"0"`), `reason`.

Clearing replaces the channel generation with a fresh random ID, resets its
revision to zero and makes composition empty/IDLE. The event is a barrier:

- The Publisher discards older pending snapshots, suggestions and actions.
- The Subscriber removes all channel content and pending derived work.
- Old-generation submissions MUST NOT be applied to the new generation.
- All active credentials receive the barrier, even without text capability.
- Credentials, permissions and authenticated connections remain valid.

A text-capable session next receives the new empty `STATE_UPDATE` before
further text state or action notifications. A repeated clear creates another
generation. A reconnect snapshot is sufficient to establish the latest state;
an offline peer need not receive every earlier clear.

### 7.4 SYSTEM_REVOKED (P to S)

Required field: `reason`, normally `user-revoked` or `channel-closed`.
The Publisher SHOULD send this authenticated event before closing with 4001,
but revocation MUST take effect even if delivery fails. On receipt, the
Subscriber clears content, deletes the credential and stops reconnecting.

For offline credentials, the Publisher MAY retain bounded non-secret
tombstones and close later attempts with 4001. Unknown/deleted credentials
may instead fail before authentication. HTTP rejection, missing tombstones or
network failure cannot reliably distinguish revocation from unavailability.
The Subscriber MUST present that ambiguity rather than claim confirmed
revocation. No tombstone is an indefinite availability guarantee.

In LOCAL, an unauthenticated close code can be forged. A bare 4001 MUST stop
automatic retries and clear content, but MUST NOT by itself delete a persistent
credential; offer the partner local forgetting or an explicit retry. Only an
authenticated revocation or local forgetting confirms credential deletion.

### 7.5 ERROR (either direction)

Required fields: `code` (reason name), `fatal` (boolean).
Optional `submissionId` correlates suggestion errors. Human-readable content
and secrets MUST NOT appear in errors. Capability-specific nonfatal errors
leave the session active. Core schema, authorization, cryptographic or
unexpected-event failures are fatal and close after clearing local content.

| WebSocket close code | Meaning | Persistent-peer response |
| --- | --- | --- |
| 4001 | Revoked/unavailable credential indication | Stop automatic retries; authenticated event required for confirmed deletion. |
| 4002 | Unsupported version/profile/capability or malformed protocol | Stop automatic retries and explain incompatibility. |
| 4003 | Authentication/authorization failed | Stop automatic retries; retain credential for explicit recovery. |
| 4004 | Credential busy | Retry with backoff; do not displace existing session. |
| 4005 | Liveness timeout | Clear; reconnect with backoff. |
| 4006 | Rate/resource limit | Clear; retry with backoff. |
| 1000, 1001, abnormal loss | Normal close, shutdown or network failure | Clear; reconnect unless locally forgotten. |

Before upgrade, malformed endpoints SHOULD receive HTTP 400; unknown credentials
SHOULD receive 404 and overload SHOULD receive 429 or 503. Those responses MUST
NOT disclose secrets. A browser may expose only a generic connection failure.

## 8. Composition state, ordering and delivery

`state.text` sends complete authoritative snapshots, not a patch history.
The Subscriber MUST NOT restore composition from disk, infer omitted text from
earlier snapshots or show text before session confirmation.

Required `STATE_UPDATE` fields: `generation`, `revision`, `state`, `buffer`.
`buffer` requires `text` (at most 4096 UTF-8 bytes); optional `truncated` is a
boolean defaulting to false. `state` is `IDLE`, `COMPOSING` or `SPEAKING`.
IDLE requires empty text; COMPOSING/SPEAKING require nonempty text.

```json
{
  "v": 2,
  "eventType": "STATE_UPDATE",
  "generation": "BQUFBQUFBQUFBQUFBQUFBQ",
  "revision": "12",
  "state": "COMPOSING",
  "buffer": { "text": "Hello", "truncated": false }
}
```

Within a generation, a changed snapshot MUST have a greater revision.
Repeated delivery of the same revision MUST represent the same state.
An initial session snapshot MUST match SESSION_OPEN's generation/revision;
the Publisher MUST serialize that pair before later changes.
Revision gaps are valid: superseded snapshots may be coalesced. Receivers MUST
NOT compare revisions across generations. On counter exhaustion a Publisher
MUST establish a new generation and invalidate old-generation work.

A generation changes on explicit clear, loss/reset of authoritative state or
Publisher restart. A restarted Publisher MUST start with empty content and a
fresh generation; pairing persistence does not imply content persistence.
The first confirmed state establishes the generation for that session.
During a session, a generation change MUST be announced by CLEAR_BUFFER.

`STATE_UPDATE` is the only composition-text message in the base profile.
The Publisher owns normalization, word joining, truncation and source
integration. The protocol does not require English punctuation rules or
whitespace collapse. Text MUST be treated as literal text, not HTML or commands.
If truncating, do not split Unicode grapheme clusters; set `truncated: true`.
Language/direction metadata and token rendering require separately defined
extensions; Unicode bidirectional text must not be treated as markup.

`state.speaking` permits SPEAKING snapshots. Without it, the Publisher maps
SPEAKING to COMPOSING for that session. Speaking state describes current
Publisher-reported activity, not an instruction to synthesize speech.
An integration's estimated hold period MUST NOT be represented as verified
playback timing; interfaces SHOULD make that distinction clear.

### 8.1 Queueing and backpressure

Superseded state snapshots MAY be discarded before encryption. Lifecycle,
action, error and suggestion events MUST NOT be silently coalesced as snapshots.
Per-session transmission is ordered; a generation barrier invalidates older
queued work before assigning subsequent sequence numbers.

Implementations MUST bound outbound queues. They MUST close a slow session
rather than allow unbounded memory growth or indefinitely queue a clear/revoke
behind content. Already-transmitted bytes cannot be withdrawn. After such a
close, a persistent peer recovers through a new handshake and snapshot.
No delivery guarantee extends across disconnection.

## 9. Optional capabilities

### 9.1 Action notifications: `action.notify`

Dependencies: `state.text`, `composition.read`. Direction: P to S.

`ACTION_NOTIFY` requires `eventId`, `generation`, `revision` and `action`.
`action` is `speech-requested` or `attention-requested`. It refers to the exact
snapshot already sent on this session; it carries no replacement text.
Each explicit AAC-user action has a new event ID, including repeated speech of
identical text. Re-sending the same ID MUST NOT repeat a side effect.

A Subscriber MUST ignore an action whose context is not its current snapshot,
or whose ID it has already processed. Actions MUST NOT be retained for replay
after reconnect or reconstructed from SPEAKING state. Delivery is best effort,
not exactly once. A Publisher MUST send the referenced snapshot first even
when that snapshot would otherwise have been coalesced.

Processed IDs need only be retained while their referenced snapshot is current:
older-context duplicates are already ineligible. Tracking MUST be bounded;
if it fills, close with 4006 rather than evict IDs and risk repeating an action.

Sound, speech and attention effects require local receiver opt-in, default off.
Support does not guarantee browser audio activation, offline voices, background
execution or actual speech playback. No partner-to-Publisher action command is
defined. Suggestions do not grant action authority.

### 9.2 Suggestions: `suggestions.submit` and `suggestions.feedback`

Dependencies: both capabilities active and `suggestions.submit` permission.
Directions: submission/withdrawal S to P; receipt/outcome P to S.
No read permission is implied. A suggestions-only peer obtains current context
from SESSION_OPEN, HEARTBEAT and CLEAR_BUFFER.

Suggestions are independent text candidates, not text-range patches or
instructions to replace, speak or append content automatically. The AAC
application chooses their presentation and the explicit user-acceptance
interaction. Any accepted edit is performed by that application and reflected
through normal Publisher-authoritative state.

#### Submission

`SUGGESTION_SUBMIT` requires `submissionId`, `generation`, `revision`,
`ttlMs` and `candidates`. `ttlMs` is an integer 1000-60000, measured from
Publisher receipt using monotonic time. `candidates` contains 1-5 objects,
each requiring a unique `suggestionId`, nonempty `text` (at most 256 UTF-8
bytes) and `kind`, one of `phrase`, `completion`, `alternative`, `hint`.
Kind describes intent only; even a completion is not automatically inserted.

```json
{
  "v": 2,
  "eventType": "SUGGESTION_SUBMIT",
  "submissionId": "BgYGBgYGBgYGBgYGBgYGBg",
  "generation": "BQUFBQUFBQUFBQUFBQUFBQ",
  "revision": "12",
  "ttlMs": 30000,
  "candidates": [
    {
      "suggestionId": "BwcHBwcHBwcHBwcHBwcHBw",
      "text": "sparkling water",
      "kind": "completion"
    }
  ]
}
```

Publisher validation and acceptance of a batch are atomic. If its context
differs from the channel's current generation/revision, reject it as stale.
A queued candidate expires on **any** composition revision change, generation
change, TTL expiry, sender disconnect or permission withdrawal.
This intentionally conservative first extension avoids applying suggestions
to a different message. A future extension may define less restrictive context.

#### Receipt is not AAC-user acceptance

`SUGGESTION_RECEIPT` requires `submissionId` and `status`, either `queued`
or `rejected`. Rejected receipts also require `reason`: `stale-context`,
`rate-limited`, `queue-full`, `unsupported-kind`, or `id-conflict`.
Queued means only "available for consideration", not "chosen by the AAC user".
Malformed messages and missing authorization are fatal protocol errors,
not success-shaped receipts.

Each credential may submit at most one new batch per second and have at most
10 queued candidates. Excess valid requests receive the appropriate rejected
receipt; persistent flooding may close with 4006.

IDs are scoped to the credential and current session. For each submission ID,
the Publisher retains its original receipt and outcomes for the session;
semantic duplicates (same declared fields and candidates, ignoring JSON
member order/unknown optional fields) return that receipt without creating
candidates. Reuse with different declared content is `id-conflict`.
An implementation MAY retain a digest of unambiguously encoded declared
fields for comparison rather than retaining terminal candidate text.
Suggestion IDs MUST NOT be reused by another batch in that session.
Duplicate tracking MUST be bounded. If capacity is exhausted, close with 4006
before accepting another batch rather than forgetting IDs and accepting a
duplicate. The capacity is an implementation resource policy, not a fixed
conversation length. Reconnection starts a new scope and MUST NOT automatically
resubmit old candidates.

#### Outcome and withdrawal

`SUGGESTION_OUTCOME` requires `submissionId`, `suggestionId` and `outcome`:
`accepted`, `dismissed`, `expired`, or `withdrawn`. `expired` additionally
requires `reason`: `ttl`, `context-changed`, or `cleared`.
An accepted outcome additionally requires `resultGeneration` and
`resultRevision`, identifying the authoritative state after the user's action.
Acceptance need not change composition, for example when acknowledging a hint.

`accepted` and `dismissed` describe explicit AAC-user choices. Absence of action
MUST NOT be reported as rejection by the user. Before processing an acceptance,
recheck context and expiry. Resolve concurrent expiry/acceptance serially so
each candidate has at most one terminal outcome.

`SUGGESTION_WITHDRAW` requires `submissionId` and `suggestionId`. An outstanding
candidate becomes withdrawn. Repeat withdrawal of a terminal candidate returns
its existing outcome. An unknown ID returns nonfatal ERROR `unknown-suggestion`
with `submissionId`.

On acceptance, send that candidate's outcome before the resulting state update;
expire other pending candidates affected by the change. On clear, send the
barrier first, then any terminal feedback without content. Old-generation
terminal feedback is allowed solely to resolve IDs; it MUST NOT restore a
candidate or composition.

Receipts/outcomes go only to the originating session. Other partners MUST NOT
receive suggestion content, partner identity or feedback unless a separately
authorized extension defines it. On disconnection, discard candidate text and
pending work; terminal delivery is not guaranteed. Store only IDs/status needed
and optional comparison digests for session duplicate handling, not a
conversation or suggestion history.

### 9.3 Symbols and other extensions

Symbol rendering is reserved, not defined by this draft. A future text-display
extension SHOULD retain `buffer.text` as a fallback and define token ordering,
symbol-set-qualified identifiers, fallback labels, resource limits, licensing
and offline asset availability. It MUST NOT require text-only peers to fetch
unknown URLs or infer token semantics.

A future non-text profile can define different mandatory capabilities without
changing what `text-display` promises.

## 10. Extension and versioning rules

Wire major 2 is not backward compatible with legacy wire 1. A peer MUST NOT
interpret one version as the other or fall back silently.

Within a frozen major version:

- Optional object fields may be added without changing existing meanings.
- New behaviour requires a named capability with explicit schemas, directions,
  dependencies, permission requirements, limits, errors and lifecycle rules.
- Unknown offered capabilities/profiles may be ignored; do not request them.
- A peer MUST NOT send capability events before SESSION_OPEN, without active
  negotiation, or outside that capability's authorized direction.
- Capabilities do not grant permissions and MUST NOT redefine core authority,
  clear barriers or the AAC-user-consent requirement.
- Incompatible changes require a new capability identifier or wire major.

The standard capability names in this draft form its initial registry.
Private capabilities MUST use `x.` followed by a reverse-domain namespace,
for example `x.org.example.symbols-v1`, and comply with the name bounds.
Publication of a private capability does not make it a standard capability.
Shared extensions SHOULD publish a stable specification, examples and tests
before proposing an entry in the maintained protocol registry.
No formal registry authority or external standards endorsement is implied.

An extension specification MUST describe safe absence/decline behaviour.
Optional fields MUST NOT smuggle a required operation past negotiation.
Unknown enum members are not automatically optional fields.

## 11. Privacy, errors and implementation freedom

Publishers and Subscribers MUST NOT persist shared composition, decrypted
events, candidate text or prior snapshots as protocol history. Pairing metadata
and non-sensitive accessibility preferences MAY persist. The source AAC
application's own user-authorized message storage is outside this protocol;
sharing MUST NOT silently add another archive.

Implementations MUST NOT log secrets, full pairing URLs, composition,
suggestion text or encrypted payloads. Diagnostics SHOULD report versions,
redacted error categories and connectivity information without content.
Labels and stable identifiers can reveal relationships; minimize exposure.

Clearing means removing application-visible state, retained references and
queued derived work. It is not a promise of forensic erasure from browser
memory, swap, screenshots, backups or another device. Implementations MUST
describe such limitations honestly.

Input validation, authentication-attempt limits, handshake deadlines, pending
connection limits and bounded queues are required. Exact resource policies
outside specified wire limits are implementation choices; overload MUST be
explicit, never silently reported as acceptance. One slow partner MUST NOT
block AAC input processing or unrelated channels.

The following are intentionally not dictated by the protocol:

- How the AAC application sends source updates to its Publisher.
- Whether a command bridge, direct API or embedded integration is used.
- Processes, threads, IPC transport, library choices or executable names.
- Clipboard use, word joining and source-edit resynchronization strategy.
- Candidate tray layout, typography, themes and interaction modality.
- Protected-storage API, installation, startup and asset packaging.

Implementers SHOULD provide accessible, user-controlled interfaces, make
sharing and connection status understandable, and avoid obscuring the user's
primary AAC interface. Specific distance typography or conformance to an
accessibility standard belongs in implementation accessibility documentation,
not a claim that wire conformance guarantees usable presentation.

## 12. Validation and interoperability gates

This draft MUST NOT be described as a frozen interoperable release until:

1. Machine-readable schemas cover all handshake, envelope and event shapes,
   conditional requirements and bounded values in this document.
2. All normative JSON examples are checked against those schemas.
3. Published language-independent known-answer vectors include fixed secret,
   IDs, nonces, offered/requested lists, exact transcript bytes, derived keys,
   prefixes, IV, AAD, plaintext, ciphertext, tag and proofs.
4. Negative vectors cover malformed Base64URL/UTF-8, list-boundary ambiguity,
   wrong version/identity/direction, replay, overflow and tag tampering.
5. The handshake/key schedule has independent cryptographic review.
6. At least two independently written implementations exchange baseline
   snapshots, clear/reconnect, revocation and suggestion messages successfully.
7. Lifecycle tests cover busy sessions, failed temporary authentication,
   loss/restart, monotonic liveness, suspended receivers, slow peers, clear
   barriers, repeated speech, stale/duplicate suggestions and permission changes.
8. Supported browser/device/network claims have recorded physical tests,
   including offline operation and storage loss.

Round trips through shared code are useful tests but do not substitute for
fixed vectors or independent interoperability. Proposed cryptographic examples
in this document are not production keys or known-answer vectors.

## Appendix A. Reference Windows/Grid integration (informative)

The legacy preview uses a resident Windows Publisher with a tray/pairing
interface and a short-lived native `aacpipe-bridge.exe`. Grid 3 copies text,
then launches the bridge. This is one source adapter, not a wire requirement.
A different AAC application may publish through a direct API without copying
text or launching another process.

Useful adapter lessons:

- Prefer authoritative full-text replacement after edits, deletes, predictions
  and before speech. Append-only word commands can drift from the real buffer.
- Combining full-text update and a speech request in one local operation
  avoids ordering races between separate process invocations.
- Clipboard access is shared, mutable and readable by other same-user
  applications. Retry locks within a bounded deadline; distinguish read failure
  from intentional clear; never mutate the clipboard as a side effect.
- Keep source acknowledgement independent of network delivery. A slow or
  disconnected partner must not interrupt ordinary AAC use.
- If using local IPC, authenticate/limit access using platform facilities.
  IPC schema versioning is independent of wire protocol versioning.
- UI show/hide flags, startup policy, process suppression and installer paths
  belong to the adapter's documentation.

The preview supports `--word`, `--sentence`, `--clear`, `--speak`, `--pair`,
`--revoke`, `--status`, direct `--text`, and window controls. These flags are
not required of alternative implementations. See the [Grid integration guide](docs/grid3-test-cell-actions.md)
and [development documentation](docs/development.md) for current usage.

## Appendix B. Legacy preview compatibility (informative)

The previous document combined wire-1 design, Windows requirements and future
ideas. Neither that document nor this revision should be taken as evidence
that every described behaviour has been implemented.

| Area | Legacy document/current preview | Proposed wire 2 |
| --- | --- | --- |
| Version | Protocol document v0.1, wire `v: 1`. | Design revision 0.2, wire `v: 2`; not implemented. |
| Pairing | Old document uses numeric `0`/`2`; preview uses `e`/`p` and query `channel`. | Explicit `#2:lifetime:cid:kid:secret` plus matching query IDs. |
| WebSocket | Old document `/?cid=...`; preview `/ws?channel=...`. | `/aacpipe/v2?channel=...&credential=...`. |
| Identity | One channel secret and 17-character Base62 channel ID. | Separate channel/credential/session; 16-byte Base64URL IDs. |
| Negotiation | Three read-only capabilities; no explicit session confirmation. | Authenticated SESSION_OPEN with active profiles, capabilities and permissions. |
| Cryptography | Legacy HKDF/transcript; shared implementation supplies details absent from prose. | Explicitly different v2 transcript/key schedule; new vectors/review required. |
| Decrypted events | Original examples omit `v`; preview schemas require it. | `v: 2` required at all three layers. |
| Restart | Saved revision with empty restored composition. | Fresh content generation, empty state, revision zero. |
| Liveness | Preview server WebSocket ping every 20 seconds. | Observable encrypted heartbeat/ACK and 30-second timeout. |
| Revocation | Old text promises offline tombstone recognition; current upgrade path rejects missing channels before that handshake. | Confirmed revocation distinguished from ambiguous pre-authentication failure. |
| Speech | SPEAKING transition with estimated hold; receiver infers optional announcement. | State separate from identified, opt-in, non-replayed action notifications. |
| Suggestions | Future sketch only; preview rejects content after authentication. | Optional specified submission/receipt/outcome lifecycle, not direct editing. |

Migration requires deliberate implementation work and new pairing credentials;
existing wire-1 secrets/URLs MUST NOT be reinterpreted as wire 2. A product MAY
run separately identified legacy and v2 endpoints during transition, but must
not imply identical guarantees or silently downgrade.

Existing implementation guidance and acceptance status remain in the
[implementation plan](implementation_plan.md), [README](README.md) and
[acceptance record](docs/acceptance-tests.md). In particular, desktop automation
does not establish physical Grid, phone or hotspot compatibility.

## Appendix C. Decisions recorded for this revision (informative)

The following policies were confirmed during the protocol review:

- Introduce draft wire major 2; label the current implementation legacy wire 1.
- Give each channel its own authoritative view; mirroring is permitted.
- Separate a small core, transport/application profiles and optional features.
- Move Windows, Grid and UI prescriptions to implementation guidance.
- Define an optional interoperable text-candidate suggestions extension.
- End temporary pairings on authenticated disconnect, with no base grace period.
- Reject a second authenticated session as busy rather than displacing the first.
- Separate speech/attention actions from snapshots; require local sound opt-in.
- Match suggestions to exact revisions; expire them on any revision change.
- Delete persistent credentials only on authenticated revocation or local
  forgetting, not an unauthenticated network indication.

Consequences include new implementation/migration work, re-pairing for v2,
possible busy waits until stale-session timeout, and new pairing after a
temporary receiver reload. These are explicit policy choices, not accidental
side effects. Wire-level proposals in this draft remain subject to the
validation gates in section 12 before freezing.
