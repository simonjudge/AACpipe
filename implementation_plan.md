# AACpipe Implementation Plan

**Plan status:** Runnable local-network MVP, unsigned Grid 3 test package and stable mDNS hostname implemented. Physical phone/hotspot interoperability and pilot-release work remain.<br>
**Target release:** v0.1 Windows / Grid 3<br>
**Last updated:** 2026-10-21<br>
**Protocol source:** [AACPipe Partner Screen App Protocol.md](./AACPipe%20Partner%20Screen%20App%20Protocol.md)

**Current gate:** Do not begin further product work until the test package has been tried with Grid 3 and the results reviewed.

This is the working delivery plan for AACpipe. Update it throughout development:

- Change `[ ]` to `[x]` only when the task and its stated verification are complete.
- Use `[-]` for work in progress and `[!]` for blocked work, adding a short reason.
- Record material architecture changes in the Decision Log.
- Record scope changes in the Change Log.
- Do not mark a milestone complete until every exit criterion is met.

## 1. Product Scope

### v0.1 goals

- Windows Publisher integrating initially with Grid 3.
- Zero-install browser Subscriber on the same trusted network or device hotspot.
- One read-only partner per channel.
- Persistent and ephemeral channel types.
- Grid 3 invokes a native command bridge using flags and clipboard text.
- Real-time text, clear, and speaking-state updates.
- Persistent pairing across normal browser and Publisher restarts.
- Immediate removal of displayed text on connection loss.
- Fully offline operation with no CDN, analytics, relay, or cloud dependency.
- LOCAL transport profile, with the protocol kept compatible with a future SECURE profile.

### Explicit v0.1 non-goals

- Partner suggestions or any partner-to-AAC content.
- Multiple Subscribers on one channel.
- Graphic symbols.
- macOS, Linux, Android, or iOS Publisher applications.
- Internet relay or operation across separate networks.
- Protection against an active attacker on the local network.
- Installable PWA behavior.
- Direct Grid 3 API integration or UI scraping.

## 2. Recommended Technology Stack

| Area                    | Choice                                                                                 | Reason                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Repository              | npm workspaces plus Cargo workspace                                                    | Simple JavaScript workspace management while supporting native Rust components.                                                          |
| Resident Publisher      | Electron main process, Node.js 22 LTS, TypeScript                                      | Node networking and shared TypeScript code, plus reliable Windows tray/window/startup integration.                                       |
| Publisher management UI | TypeScript, React, Vite                                                                | QR display, channel management, diagnostics, and accessible settings UI.                                                                 |
| Subscriber SPA          | TypeScript, React, Vite                                                                | Small browser app with shared schemas and predictable accessibility testing.                                                             |
| Command bridge          | Rust stable, Windows GUI subsystem                                                     | Fast startup, no console flash, direct clipboard/process/mutex APIs, and low memory use.                                                 |
| Windows native support  | Rust Node-API addon using `napi-rs` and the `windows` crate                            | Secure named-pipe creation, DPAPI, and other Windows primitives that Node does not expose safely.                                        |
| HTTP                    | Fastify                                                                                | Small, typed HTTP server with explicit limits and headers.                                                                               |
| WebSocket               | `ws` behind the Fastify upgrade path                                                   | Mature Node WebSocket implementation with control-frame ping/pong support.                                                               |
| Runtime validation      | Zod                                                                                    | TypeScript types alone do not validate hostile wire or IPC input.                                                                        |
| Cryptography            | Reviewed pure TypeScript packages from the Noble project, subject to Milestone 0 spike | The LOCAL HTTP page cannot assume Web Crypto is available. The same implementation can generate deterministic browser/Node test vectors. |
| Persistence             | Versioned JSON metadata plus DPAPI-protected secret blobs; atomic file replacement     | Small v0.1 data model without introducing a database, while keeping secrets protected at rest.                                           |
| mDNS                    | `@homebridge/ciao`                                                                     | Local service discovery, collision probing and live network-interface monitoring.                                                        |
| QR generation           | A local QR encoder package with no runtime network dependency                          | Generate pairing QR codes fully offline.                                                                                                 |
| TypeScript tests        | Vitest                                                                                 | Fast unit and integration testing across shared packages and apps.                                                                       |
| Browser tests           | Playwright                                                                             | Subscriber behavior, reconnect, storage, responsive layout, and accessibility flows.                                                     |
| Rust tests              | Cargo test plus Clippy                                                                 | Native bridge, argument parser, clipboard abstraction, and Windows integration tests.                                                    |
| Packaging               | Electron Builder with per-user NSIS installer                                          | Packages Electron, Node runtime, SPA assets, native addon, and Rust bridge for Windows.                                                  |
| CI                      | GitHub Actions on Windows                                                              | Exercises the actual target platform and builds the installer.                                                                           |

### Architecture constraint

The shipped installation contains two executables:

1. `AACpipe.exe` — the resident Electron Publisher.
2. `aacpipe-bridge.exe` — the short-lived Rust command bridge invoked by Grid 3.

The installer may expose a stable `aacpipe.exe` compatibility launcher or install the bridge under that name if Grid 3 configuration requires it. The final executable naming is a Milestone 0 decision because it must agree with the protocol examples and installer behavior.

## 3. Proposed Repository Structure

```text
AACpipe/
├─ AACPipe Partner Screen App Protocol.md
├─ implementation_plan.md
├─ README.md
├─ package.json
├─ package-lock.json
├─ tsconfig.base.json
├─ eslint.config.js
├─ Cargo.toml
├─ apps/
│  ├─ publisher/
│  │  ├─ package.json
│  │  ├─ src/
│  │  │  ├─ main/                 # Electron main process
│  │  │  │  ├─ bootstrap/
│  │  │  │  ├─ channels/
│  │  │  │  ├─ commands/
│  │  │  │  ├─ config/
│  │  │  │  ├─ http/
│  │  │  │  ├─ ipc/
│  │  │  │  ├─ mdns/
│  │  │  │  ├─ persistence/
│  │  │  │  ├─ streaming/
│  │  │  │  ├─ tray/
│  │  │  │  └─ websocket/
│  │  │  ├─ preload/
│  │  │  └─ renderer/             # Publisher management UI
│  │  └─ tests/
│  └─ subscriber/
│     ├─ package.json
│     ├─ src/
│     │  ├─ app/
│     │  ├─ connection/
│     │  ├─ crypto/
│     │  ├─ pairing/
│     │  ├─ storage/
│     │  └─ ui/
│     └─ tests/
├─ packages/
│  ├─ protocol/                   # Wire types, schemas, codecs, capabilities
│  ├─ crypto/                     # HKDF, transcript, IV, AEAD framing
│  ├─ domain/                     # Buffer, commands, revisions, channel lifecycle
│  ├─ config/                     # Publisher runtime schema and defaults
│  ├─ ipc-schema/                 # Bridge request/response schema
│  ├─ test-vectors/               # Language-neutral JSON fixtures
│  └─ test-support/
├─ crates/
│  ├─ bridge/                     # Fast Grid 3 command executable
│  │  ├─ Cargo.toml
│  │  └─ src/
│  └─ win32-native/               # napi-rs secure pipe and DPAPI addon
│     ├─ Cargo.toml
│     └─ src/
├─ tests/
│  ├─ contract/                   # TS/Rust IPC and crypto compatibility
│  ├─ e2e/                        # Publisher + real browser
│  ├─ fixtures/
│  └─ manual/
│     └─ grid3-test-matrix.md
├─ docs/
│  ├─ architecture/
│  │  └─ decisions/               # ADRs
│  ├─ grid3/
│  ├─ privacy/
│  ├─ testing/
│  └─ user/
├─ scripts/
│  ├─ build/
│  ├─ test/
│  └─ package/
└─ .github/
   └─ workflows/
```

### Package boundaries

- `packages/domain` has no Electron, browser, Node networking, or Windows dependencies.
- `packages/protocol` defines validated wire shapes but does not open sockets.
- `packages/crypto` consumes and produces byte arrays and has no UI or storage behavior.
- `packages/ipc-schema` is the single source of truth for bridge/Publisher commands.
- The Publisher orchestrates domain, transport, storage, and native services.
- The Subscriber imports protocol and crypto packages but never Publisher code.
- Rust duplicates only the minimal IPC schema needed by the bridge; shared contract fixtures prove compatibility.

## 4. Runtime Architecture

### Publisher startup

1. Electron enforces one resident instance per Windows user.
2. Load configuration and validate its schema.
3. Load channel metadata, unprotect secrets through DPAPI, and validate revisions.
4. Start the secure local named-pipe listener through `win32-native`.
5. Start HTTP and WebSocket listeners on the configured LAN interface.
6. Advertise the persisted per-device mDNS hostname.
7. Create the tray and management window.
8. Restore persistent channels, but never restore composition text to a Subscriber before authenticated state synchronisation.

### Grid 3 command path

1. Grid 3 places text on the clipboard and launches `aacpipe-bridge.exe`.
2. The bridge validates flags and reads `CF_UNICODETEXT`.
3. It connects to the per-user secure named pipe.
4. If the pipe is absent, it silently starts the Publisher and retries within the deadline.
5. Publisher validates the IPC request and applies it to the domain buffer.
6. Publisher acknowledges immediately.
7. Publisher asynchronously coalesces and encrypts a complete state snapshot.
8. Bridge exits with the documented code.

### Subscriber path

1. Browser loads the embedded SPA from the Publisher.
2. SPA parses the fragment and removes it from the visible URL.
3. Persistent channels store only the pairing record; message content is memory-only.
4. SPA authenticates over WebSocket and negotiates capabilities.
5. Publisher sends an authoritative full snapshot.
6. SPA clears content immediately on socket loss.
7. Persistent channels reconnect with bounded exponential backoff.

## 5. Cross-Cutting Engineering Rules

- Validate all IPC, stored, URL, and wire data at runtime.
- Keep message content and secrets out of normal logs, crash reports, and telemetry.
- Never fetch code, fonts, images, or packages at runtime.
- Use dependency lock files and review production dependency licenses and maintenance status.
- Use structured logs with event names, redacted identifiers, and bounded retention.
- Treat `CLEAR_BUFFER` and `SYSTEM_REVOKED` as priority events that bypass debounce queues.
- Use atomic persistence writes and retain the last valid version on failed update.
- Keep UI strings externalizable even if v0.1 ships only in English.
- Test keyboard, touch, eye-gaze-equivalent dwell, switch-like sequential focus, and screen reader behavior.
- Do not add partner write paths to v0.1 merely because protocol types reserve them.

## 6. Milestones and Tasks

## Milestone 0 — Architecture Spikes and Protocol Freeze

**Objective:** Eliminate high-risk unknowns before building production surfaces.

### Tasks

- [ ] Create ADR-001 documenting Electron/TypeScript Publisher, React Subscriber, and Rust bridge.
- [ ] Decide final installed executable names and update protocol examples if they differ.
- [ ] Specify exact HKDF salt, `info`, output lengths, transcript encoding, associated-data encoding, and directional labels.
- [ ] Create language-neutral crypto test-vector format.
- [ ] Spike the selected Noble crypto packages in Chromium over LAN HTTP and Node.js.
- [ ] Verify AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256, and constant-time proof comparison behavior.
- [ ] Spike Rust bridge cold/warm startup on representative Grid 3 hardware.
- [ ] Confirm a GUI-subsystem Rust bridge produces no console flash.
- [ ] Confirm Grid 3 can reliably sequence copy-to-clipboard then run-program actions.
- [ ] Confirm Grid 3 can provide new-word text for `--word` and full message text for `--sentence`.
- [ ] Spike the `napi-rs` secure named-pipe listener with same-user DACL and remote-client rejection.
- [ ] Spike DPAPI protect/unprotect through the Rust native addon.
- [ ] Verify Electron packaging can load the native addon and bundled Rust bridge after installation.
- [ ] Test mDNS resolution on supported Android Chrome and iOS Safari versions.
- [ ] Define supported Windows, Grid 3, Android Chrome, and iOS Safari version matrix.
- [ ] Define normative size limits and schemas for every handshake, envelope, and payload.
- [ ] Resolve whether persistent storage is sufficiently durable in supported mobile browsers.
- [ ] Add the resolved protocol details and test vectors to the protocol specification.

### Exit criteria

- [ ] Crypto test vector passes in Node and the target browser implementation.
- [ ] Secure pipe round trip passes between Rust bridge and packaged Electron Publisher.
- [ ] Bridge meets the target startup budget, or a measured revised budget is approved and documented.
- [ ] A Grid 3 test cell successfully sends word, sentence, clear, and speak commands.
- [ ] Browser/platform support matrix and all v0.1 wire encodings are frozen.

## Milestone 1 — Repository and Quality Foundation

**Objective:** Establish reproducible builds and enforce package boundaries.

### Tasks

- [x] Initialize npm workspaces and generate `package-lock.json`.
- [x] Add the Cargo workspace manifest and Rust crate scaffolds, and generate `Cargo.lock`.
- [x] Add shared TypeScript configuration with strict mode and no unchecked indexed access.
- [x] Configure ESLint and Prettier.
- [x] Configure Rustfmt and Clippy with warnings denied in CI.
- [x] Create all workspace packages and applications with minimal buildable entry points.
- [x] Add root scripts: `build`, `test`, `test:e2e`, `lint`, `typecheck`, `format:check`, and `package`.
- [x] Add Vitest with coverage reporting.
- [x] Add the Playwright placeholder command; browser configuration is deferred to Milestone 6 when the Subscriber exists.
- [x] Add Windows CI for TypeScript, Rust, contract tests, and packaging smoke-test foundation jobs.
- [x] Add a production dependency audit command and run it successfully with zero reported production vulnerabilities.
- [x] Add a minimal README with supported workflows and exact development commands.
- [x] Add contribution guidance for updating this plan and the protocol.

### Exit criteria

- [x] Clean checkout installs and TypeScript builds using documented commands.
- [x] Local equivalents of lint, type-check, unit-test, Rust-test, and build checks pass. The Windows CI workflow is configured for the same checks; its first remote run remains a release-process follow-up.
- [x] No production application code crosses the documented package boundaries.

### Milestone 1 verification record

- `npm install` — passed; generated `package-lock.json`.
- `npm run lint` — passed.
- `npm run format:check` — passed.
- `npm run typecheck` — passed.
- `npm test` — passed with no tests yet present (`passWithNoTests` is intentional for the scaffold).
- `npm run build` — passed.
- `npm audit --omit=dev` — passed with zero production vulnerabilities reported.
- `cargo fmt --all --check` — passed locally.
- `cargo clippy --workspace --all-targets -- -D warnings` — passed locally.
- `cargo test --workspace` — passed locally: 2 unit tests passed; doc-tests passed.
- `Cargo.lock` — generated by Cargo and included in the workspace.
- Rust toolchain — stable 1.99.0, MSVC target; `rustfmt` and `clippy` components installed.

The foundation is ready for Milestone 2 implementation. The first CI run should verify the same commands on a clean Windows runner.

## Milestone 2 — Domain Model and IPC Contract

**Objective:** Implement and thoroughly test all behavior that does not require networking or UI.

### Tasks

- [x] Define domain command types for word, sentence, clear, speak, pair, revoke, and status.
- [x] Implement the append-only buffer and exact punctuation/whitespace join rules.
- [x] Implement UTF-8 byte limits and grapheme-safe oldest-text truncation.
- [x] Implement state transitions for IDLE, COMPOSING, and SPEAKING.
- [x] Implement speaking modifiers and cancellation by subsequent content command.
- [x] Implement canonical unsigned 64-bit revision handling with overflow failure.
- [x] Implement full-snapshot generation and `buffer.truncated`.
- [x] Implement update coalescing while preserving immediate clear events.
- [x] Define and validate versioned IPC request and response schemas.
- [x] Generate shared IPC fixtures for every command and every validation failure.
- [x] Implement configuration schema and defaults.
- [x] Add property-based tests for buffer operations, Unicode, limits, and revisions.
- [x] Add tests proving failed commands cannot mutate state.

### Exit criteria

- [x] Domain package has no platform or transport imports.
- [x] Every implemented command, state transition, limit, and error path has tests.
- [x] TypeScript and Rust agree on acceptance and normalized output for all IPC contract fixtures.

### Milestone 2 verification record

- `npm run lint` — passed.
- `npm run format:check` — passed.
- `npm run typecheck` — passed.
- `npm test` — passed: 85 tests across 4 test files.
- `npm run build` — passed.
- `npm audit --omit=dev` — passed with zero production vulnerabilities reported.
- `cargo fmt --all --check` — passed locally.
- `cargo clippy --workspace --all-targets -- -D warnings` — passed locally.
- `cargo test --workspace` — passed locally: 3 unit tests and doc-tests passed, including the shared IPC contract corpus.

Milestone 2 is complete locally. The shared JSON corpus covers every v0.1 command, schema boundary failures, Unicode byte limits, normalization defaults, and success/failure responses. TypeScript and Rust both validate the same corpus and compare normalized valid outputs.

## Milestone 3 — Native Bridge and Windows Primitives

**Objective:** Deliver a reliable, fast Grid 3 command path into a Publisher stub.

### Tasks

- [x] Implement Rust CLI parsing and conflict validation.
- [x] Build as a Windows GUI-subsystem executable with no console window.
- [x] Implement `CF_UNICODETEXT` acquisition, retry, normalization, and validation.
- [x] Implement `--text` precedence over clipboard.
- [x] Implement named-pipe client framing, deadlines, and response parsing.
- [x] Implement exact documented exit-code mapping.
- [x] Implement per-user single-start and Publisher-lifetime mutexes with silent Publisher auto-start.
- [x] Implement the Node-API secure named-pipe server.
- [x] Implement DPAPI protect/unprotect APIs with zeroization of temporary plaintext buffers.
- [x] Add a Publisher stub that accepts every command and returns deterministic responses.
- [x] Test concurrent rapid bridge launches and single Publisher startup.
- [x] Test locked, empty, non-text, oversized, malformed UTF-16, and changing clipboard cases.
- [x] Benchmark cold and warm bridge invocation at the 50th, 95th, and 99th percentiles.
- [x] Test behavior under antivirus scanning on representative hardware where possible.

### Exit criteria

- [x] Bridge reliably delivers 10,000 sequential test commands without loss or deadlock.
- [x] Concurrent startup test creates exactly one Publisher.
- [x] Named pipe rejects another Windows user and remote access.
- [x] Latency results meet or explicitly revise the agreed budget.

### Local validation record

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, and `npm run build` passed. Vitest reported 88 passing tests.
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace -- --test-threads=1` passed. Rust reported 16 passing tests.
- The packaged `.node` addon loaded in Node.js and completed a DPAPI protect/unprotect round trip.
- The release bridge delivered word, sentence, speak, clear, pair, status, and revoke commands through the real per-user named pipe to the TypeScript Publisher stub.
- A release stress harness delivered 10,000 sequential commands in 6.091 seconds without loss or deadlock, averaging 609 microseconds per pipe transaction.
- Twenty simultaneous cold bridge processes completed in 378.068 ms, all returned exit code 0, and the launch record contained exactly one Publisher process.
- Process-level latency over 50 warm release-bridge invocations was p50 23.286 ms, p95 33.584 ms, and p99 67.785 ms. Publisher auto-start plus first command took 324.238 ms.
- Windows Defender antivirus and real-time protection were enabled during the concurrency, stress, and latency runs.
- `npm audit --omit=dev` reported zero production dependency vulnerabilities.
- A kernel-level pipe test verified a single current-user access-control entry and confirmed that an SMB-style `\\localhost\pipe\...` open is rejected.
- Clipboard tests cover permanent and transient lock contention, empty and non-text input, oversize and odd allocations, malformed UTF-16, normalization, and mutation after snapshot. Contention is injected deterministically because this automation session is denied direct interactive clipboard ownership.

## Milestone 4 — Publisher Core and Channel Persistence

**Objective:** Implement the long-running Windows Publisher excluding encrypted Subscriber streaming.

### Tasks

- [ ] Create Electron lifecycle, single-instance handling, tray, and management window.
- [x] Integrate the secure named-pipe server with the domain command handler.
- [x] Implement channel creation with CSPRNG channel IDs and secrets.
- [x] Implement persistent and ephemeral channel registries.
- [x] Implement DPAPI-protected persistent secret storage.
- [x] Implement atomic metadata writes and schema migrations.
- [x] Implement non-secret revocation tombstones and bounded cleanup policy.
- [x] Implement stable per-Publisher device ID and mDNS hostname persistence.
- [x] Implement channel label validation and privacy-preserving display.
- [x] Implement pair, revoke-one, revoke-all, clear, and status management commands.
- [x] Implement pairing URL generation using the compact fragment format.
- [ ] Implement configuration UI for ports, timeouts, speaking hold, and update interval.
- [ ] Implement structured redacted logging and log rotation.
- [x] Ensure composition text and pairing URLs never enter logs.
- [x] Restore persistent channel metadata after restart without restoring Subscriber-visible content prematurely.

### Exit criteria

- [x] Persistent channels and revisions survive clean restart in the registry layer.
- [x] Secrets are protected before persistence and are not readable as plaintext in application data files.
- [x] Revocation destroys the secret-bearing record while preserving a channel tombstone.
- [ ] All management commands work through both bridge and management UI.

## Milestone 5 — Wire Protocol and Encrypted WebSocket Server

**Objective:** Implement the frozen v0.1 protocol with negative-path coverage.

### Tasks

- [x] Implement Base62 channel ID and Base64URL codecs with strict canonical validation.
- [x] Implement length-prefixed transcript and associated-data encoders.
- [x] Implement HKDF key separation and per-direction traffic contexts.
- [x] Implement deterministic IV derivation from prefix and sequence.
- [x] Implement AES-GCM sealing/opening with 128-bit tags.
- [x] Implement CHALLENGE and AUTH_RESPONSE state machine.
- [x] Implement capability negotiation and mandatory-capability enforcement.
- [x] Implement constant-time proof comparison.
- [ ] Implement pending-handshake limits, timeout, and failed-attempt rate limiting.
- [x] Implement authenticated envelope sequence and direction checks.
- [x] Implement private close codes 4001, 4002, and 4003.
- [x] Implement authenticated state, clear, and revoke frames.
- [x] Implement WebSocket heartbeat; ephemeral channels remain in-memory only.
- [ ] Implement socket backpressure and latest-snapshot coalescing.
- [x] Serve the Subscriber assets with CSP, no-referrer, no framing, and no third-party resources.
- [ ] Add protocol fuzz and malformed-frame tests.
- [ ] Add tests for replay, sequence rollback, altered associated data, wrong direction, wrong tag, and unknown capability.

### Exit criteria

- [x] Shared crypto round trips and tamper rejection pass.
- [x] No unauthenticated in-memory transport receives composition state.
- [x] Sequence, associated-data, tag, capability, and authorization failures are rejected in the protocol/session layer.
- [x] Clear and revoke are dispatched as authenticated lifecycle events.

> The runnable MVP uses a real HTTP/WebSocket listener and locally bundled
> browser assets. Rate limiting, backpressure hardening, fuzzing, and packaged
> lifecycle work remain Milestone 8/9 activities.

## Milestone 6 — Subscriber SPA

**Objective:** Deliver the accessible zero-install partner screen.

### Tasks

- [x] Implement compact fragment parsing with strict length and character validation.
- [x] Remove fragment immediately using history replacement.
- [x] Implement ephemeral in-memory pairing.
- [x] Implement persistent IndexedDB pairing record with schema versioning.
- [x] Detect unavailable persistent storage and warn rather than promise persistence.
- [x] Never store message content or decrypted payloads.
- [x] Implement proof-of-possession handshake and capability selection.
- [x] Implement encrypted envelope validation and decryption.
- [x] Render IDLE, COMPOSING, SPEAKING, disconnected, revoked, and incompatible states.
- [x] Clear displayed and in-memory content synchronously on socket loss.
- [x] Implement bounded exponential reconnect with jitter for persistent channels.
- [x] Stop reconnecting and delete credentials after confirmed revocation.
- [x] Implement responsive distance typography and safe long-word wrapping.
- [ ] Implement light/dark high-contrast themes meeting WCAG AAA color contrast.
- [x] Render all content as text, never HTML.
- [ ] Test Unicode, bidirectional text, emoji/grapheme clusters, and maximum-size buffers.
- [ ] Add accessible announcements that do not repeatedly interrupt the partner.
- [ ] Add mobile orientation, background/foreground, lock/unlock, and tab-restoration tests.

### Exit criteria

- [x] Refresh reconnects persistent channels without QR rescan in the automated Chromium test browser.
- [x] No prior text appears before fresh authenticated synchronisation.
- [x] Disconnect visibly clears text within the next browser task.
- [x] Revocation removes the persisted pairing record.
- [ ] Accessibility and supported-browser test matrix passes.

## Milestone 7 — Vertical Slice and Grid 3 Integration

**Objective:** Prove the complete user journey on real devices.

### Tasks

- [ ] Create a minimal Grid 3 test grid containing word, punctuation, prediction, delete, sentence, speak, clear, pair, and revoke cells.
- [x] Document exact Grid 3 cell action ordering.
- [x] Run bridge → IPC → domain → encryption → WebSocket → real browser vertical-slice tests.
- [x] Verify punctuation and spacing against the domain append/sentence rules.
- [x] Verify sentence resynchronisation after deliberate append-only drift.
- [x] Verify speak sends a full sentence before SPEAKING.
- [x] Verify clear immediately removes text and does not revoke pairing.
- [x] Verify Publisher auto-start preserves the triggering command.
- [x] Verify persistent pairing through Publisher restart and browser refresh; Windows reboot remains a physical acceptance check.
- [ ] Verify ephemeral pairing ends on disconnect. One-time pairing is implemented (window, tray, and `--pair --ephemeral`; ends on authenticated disconnect, manual end, or quit) with unit coverage; physical-phone verification remains.
- [ ] Verify partner-page Options (speak aloud, alert tone, keep screen awake, local Forget) on physical Android Chrome and iOS Safari.
- [ ] Verify home Wi-Fi and Windows hotspot workflows.
- [ ] Verify mDNS on physical partner devices and hotspots; labelled direct-IP compatibility fallbacks are implemented and documented.
- [ ] Test Android Chrome and iOS Safari on physical devices.
- [ ] Conduct an initial session with at least one Grid 3 user or representative accessibility tester.
- [ ] Record usability findings without storing communicated text.

### Exit criteria

- [ ] The agreed end-to-end scenarios pass on the supported device matrix.
- [ ] No critical-path Grid 3 action is blocked by bridge or network work.
- [x] Known append-only drift is understandable and recoverable through documented cells.
- [ ] Accessibility tester blockers are resolved or explicitly defer release.

## Milestone 8 — Hardening, Privacy, and Reliability

**Objective:** Make the vertical slice safe and dependable enough for pilot use.

### Tasks

- [ ] Threat-model LOCAL transport, pairing QR exposure, local IPC, storage, logs, and installer.
- [ ] Audit all log and error paths for message/secret leakage.
- [ ] Test abrupt process termination during every persistence write.
- [ ] Test sleep/resume, network changes, IP changes, hotspot toggling, and clock changes.
- [ ] Test slow Subscriber backpressure and reconnect storms.
- [ ] Test malformed clipboard and command floods from the same user.
- [ ] Set explicit memory, socket, pending-handshake, and channel-count limits.
- [ ] Add CSP and dependency integrity regression tests.
- [ ] Run dependency vulnerability and license review.
- [ ] Run code signing and SmartScreen installation tests with the intended certificate.
- [ ] Verify uninstaller choices preserve or delete pairings only with explicit user wording.
- [ ] Create a privacy notice explaining LOCAL insecurity and clipboard exposure.
- [ ] Create troubleshooting diagnostics that never expose text or secrets.
- [ ] Perform an external or independent security review of cryptographic integration before wider release.

### Exit criteria

- [ ] No unresolved critical or high-severity security issue.
- [ ] Recovery tests show no corrupted active channel registry.
- [ ] Privacy notice and diagnostics behavior match actual implementation.
- [ ] Pilot release meets agreed reliability and resource thresholds.

## Milestone 9 — Installer, Documentation, and Pilot Release

**Objective:** Produce a signed, supportable Windows pilot build.

### Tasks

- [x] Build unsigned per-user NSIS test installer with Publisher, bridge, native addon, and embedded SPA.
- [x] Package bridge-triggered Publisher auto-start and configure uninstall to delete pairing data.
- [ ] Verify clean installation and pairing-data deletion on uninstall.
- [ ] Add Windows Firewall guidance or installer rule only if required and narrowly scoped.
- [ ] Sign installer and executables.
- [ ] Add first-run explanation of LOCAL security limitations.
- [ ] Add Publisher quick-start and partner pairing guide.
- [ ] Add Grid 3 grid-authoring guide and downloadable example grid.
- [ ] Add channel management, clear, revoke, and lost-device guidance.
- [ ] Add supported-platform and known-limitations documentation.
- [ ] Document export-free diagnostics and support workflow.
- [ ] Create release checklist and semantic versioning policy.
- [ ] Produce installer checksum and software bill of materials.
- [ ] Run clean-machine installation, upgrade, rollback, and uninstall tests.
- [ ] Tag v0.1 pilot and archive protocol/test-vector versions used by the build.

### Exit criteria

- [ ] Signed installer passes clean Windows installation and launch tests.
- [ ] A new user can pair, communicate, clear, reconnect, and revoke using only published guidance.
- [ ] Release artifacts are reproducible from the tagged source.
- [ ] Pilot support and rollback plans are documented.

## 7. Test Strategy

### Unit tests

- Buffer joins, punctuation, Unicode, truncation, and revision transitions.
- Schema validation and canonical encodings.
- Key derivation, IV construction, associated data, and envelopes.
- Command parsing, clipboard normalization, and exit-code mapping.
- Channel lifecycle, expiration, clear, and revoke.

### Contract tests

- TypeScript and Rust IPC fixtures.
- Node and browser crypto fixtures.
- Stored-data schema and migrations.
- QR fragment parser/generator round trips.

### Integration tests

- Rust bridge against the real secure named-pipe server.
- Publisher persistence through restart and failed writes.
- WebSocket handshake and encrypted state delivery.
- mDNS advertisement and hostname persistence.

### End-to-end tests

- Packaged Publisher plus real Rust bridge plus Playwright browser.
- Real Grid 3 test grid on Windows.
- Physical Android and iOS partner devices.
- Home Wi-Fi and Windows hotspot.

### Non-functional targets to confirm in Milestone 0

| Measure                                               | Initial target                          |
| ----------------------------------------------------- | --------------------------------------- |
| Warm `--word` bridge p95                              | ≤ 100 ms                                |
| Cold bridge with running Publisher p95                | ≤ 250 ms                                |
| Publisher auto-start and command delivery             | ≤ 1500 ms                               |
| Accepted command to browser update p95 on local Wi-Fi | ≤ 200 ms                                |
| Visible clear after Publisher command                 | ≤ 200 ms                                |
| Subscriber clear after detected disconnect            | Immediate browser task                  |
| Publisher idle memory                                 | Measure; provisional target ≤ 200 MiB   |
| Subscriber initial asset payload                      | Provisional target ≤ 500 KiB compressed |

## 8. Development Commands (Planned)

These commands become authoritative after Milestone 1 creates the manifests:

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run package

cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

During development, prefer targeted workspace commands before the full suite.

## 9. Decision Log

| Date       | Decision                                                                                                                                                                                   | Reason                                                                                                               | Status                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 2026-10-08 | v0.1 prioritizes zero-install LOCAL mode over active-local-attacker protection.                                                                                                            | Lowest-friction first implementation; limitations are explicit.                                                      | Accepted              |
| 2026-10-08 | Use the AAC device hotspot away from trusted home networks.                                                                                                                                | Avoid arbitrary public Wi-Fi and AP isolation.                                                                       | Accepted              |
| 2026-10-08 | Persistent pairing survives reload/restart until revocation, while message content never persists in the Subscriber.                                                                       | Convenience without retaining conversation content.                                                                  | Accepted              |
| 2026-10-08 | v0.1 is one partner per channel and content-read-only.                                                                                                                                     | Reduce first-release scope while preserving extension points.                                                        | Accepted              |
| 2026-10-08 | Subscriber clears content on any unexpected connection loss.                                                                                                                               | Privacy-first display behavior.                                                                                      | Accepted              |
| 2026-10-08 | Grid 3 invokes a flag-driven bridge using clipboard text.                                                                                                                                  | Avoid UI scraping and product-specific APIs.                                                                         | Accepted              |
| 2026-10-08 | `--word` is append-only; drift is accepted until `--sentence` or `--clear`.                                                                                                                | Simple and low latency.                                                                                              | Accepted              |
| 2026-10-08 | Bridge silently auto-starts the resident Publisher and delivers the original command.                                                                                                      | No manual recovery after reboot.                                                                                     | Accepted              |
| 2026-10-08 | Use TypeScript/Node.js for Publisher and browser, Rust for the native bridge.                                                                                                              | Balance shared web development with predictable native startup.                                                      | Accepted              |
| 2026-10-08 | Use Electron for the resident Publisher shell.                                                                                                                                             | Provides Windows tray, windows, autostart, and Node hosting in one supported package.                                | Proposed; validate M0 |
| 2026-10-08 | Use a Rust Node-API addon for secure pipes and DPAPI.                                                                                                                                      | Node alone cannot guarantee the required Windows primitives.                                                         | Proposed; validate M0 |
| 2026-10-08 | Milestone 1 uses inert TypeScript/Rust entry points and defers runtime dependencies.                                                                                                       | Establish reproducible workspace/tooling boundaries before protocol implementation.                                  | Accepted              |
| 2026-10-09 | Use audited Noble synchronous primitives for shared browser/Node protocol cryptography.                                                                                                    | LOCAL HTTP origins cannot rely on secure-context Web Crypto, while the protocol still requires browser-side AES-GCM. | Accepted              |
| 2026-10-17 | Use an unsigned per-user NSIS installer with an Electron tray/window shell; delete `%LOCALAPPDATA%\AACpipe` data on uninstall.                                                             | Package a local Grid 3 test build; defer signing and broader release work until after physical testing.              | Accepted              |
| 2026-10-19 | Partner-page Forget is local-only; one-time pairing can start from the AACpipe window/tray or a Grid cell.                                                                                 | Keep the Subscriber receive-only per protocol; the AAC user stays in control of revocation.                          | Accepted              |
| 2026-10-19 | Channel labels are unique (case-insensitive) and replace channel IDs for bridge revocation; window-created permanent pairings require a label, bridge pairings without one are auto-named. | Grid cells and AAC users can name partners instead of copying random IDs.                                            | Accepted              |
| 2026-10-19 | Content bridge commands hide the pairing window by default; any command can carry `--show`/`--hide` (optional IPC `window` field), and either flag alone only shows/hides the window.      | Stop the AACpipe window covering Grid 3 while letting pairing cells bring it forward.                                | Accepted              |

| 2026-10-21 | Recommend a persisted per-installation `.local` hostname, retaining labelled IP-address links for both channel types. No browser pairing migration is required. | Stable origins where mDNS works, with the already-tested IP path available on incompatible networks. | Accepted |

## 10. Open Decisions

- [x] Final executable names and Grid 3 command paths.
- [ ] Minimum supported Windows and Grid 3 versions.
- [ ] Minimum supported Android Chrome and iOS Safari versions.
- [x] Select `@homebridge/ciao` for mDNS; physical Android/iPhone and hotspot interoperability remains an acceptance check.
- [ ] Electron idle-resource budget and whether a lighter shell is required.
- [ ] Code-signing certificate and release identity.
- [ ] Installer behavior for Windows startup and firewall configuration.
- [ ] Revocation tombstone retention duration.
- [ ] Whether the management UI permits multiple one-partner channels simultaneously in v0.1.
- [ ] Whether persistent pairing is disabled on browsers that cannot request or demonstrate durable storage.
- [ ] Exact supported Grid 3 method for copying a new word versus the full message bar.

## 11. Change Log

| Date       | Change                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-21 | Added stable `.local` discovery using `@homebridge/ciao`, persisted collision-resolved identities, recommended hostname QR codes, and IP-address compatibility fallbacks. Discovery failures do not block Grid IPC or HTTP.   |
| 2026-10-08 | Initial implementation plan created from protocol v0.1 and agreed Grid 3 command-bridge approach.                                                                                                                             |
| 2026-10-08 | Completed local Milestone 1 validation after installing Rust stable 1.99.0 with rustfmt and clippy; generated Cargo.lock and cleared the Rust validation block.                                                               |
| 2026-10-08 | Added Windows PowerShell guidance for refreshing the user-local Cargo path after Rustup installation.                                                                                                                         |
| 2026-10-08 | Completed Milestone 2 domain behavior, configuration defaults, and normalized TypeScript/Rust IPC contract fixtures; full validation passed.                                                                                  |
| 2026-10-08 | Implemented the Milestone 3 bridge, native addon, secure pipe, Publisher stub, auto-start/lifetime locks, stress harness, and local performance validation.                                                                   |
| 2026-10-09 | Completed Milestone 3 adversarial clipboard coverage and kernel-level DACL/remote-pipe verification; all tasks and exit criteria now pass locally.                                                                            |
| 2026-10-09 | Delivered the runnable local-network MVP with QR pairing, encrypted WebSocket delivery, persistent browser reconnect, live revocation, and real-browser/native-bridge validation.                                             |
| 2026-10-17 | Packaged and smoke-tested the unsigned per-user Grid 3 test installer; paused further product work for physical Grid 3 feedback.                                                                                              |
| 2026-10-19 | Added partner-page Options (speak aloud, alert tone, keep screen awake, local-only Forget) and one-time pairing from the window, tray, and Grid bridge; rebuilt the test installer.                                           |
| 2026-10-19 | Channel labels became unique identifiers: `--revoke --label` replaced `--revoke --channel`, unlabelled pairings are auto-named, and the pairing window gained New permanent pairing and confirmed per-pairing Revoke buttons. |
| 2026-10-19 | Added bridge `--show`/`--hide` window control; word, sentence, speak and clear hide the pairing window (including on cold start) so it no longer covers Grid 3.                                                               |
