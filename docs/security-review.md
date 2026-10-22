# Preview security and dependency review

Scope: LOCAL HTTP/bootstrap, pairing/management boundaries, dependency lockfile
and preview packaging. This is not a penetration-test certification.

| Severity | Finding | Disposition |
| --- | --- | --- |
| HIGH | Active network attacker can replace HTTP receiver/bootstrap JS and obtain pairing credentials; affects `.local` and IP | Accepted by maintainer only for a clearly restricted trusted-network preview. Authenticated HTTPS/WSS/bootstrap remains a broader-release gate. |
| MEDIUM | Loopback-only management allowed another local Windows account to fetch pairing secrets/control pairings | Remediated with random in-memory capability, timing-safe cookie check, HttpOnly/SameSite cookie provisioned only by Electron; CSRF token and Origin checks retained. |

Management capability tests cover absent, wrong and exact credentials. Packaged
smoke checks ordinary unauthenticated loopback GET denial and foreign-origin
POST denial with otherwise valid credentials, plus normal UI revoke.
Same-user malware remains outside the security boundary.

## Dependency triage

The preview upgrades Electron and the test/build toolchain, replacing the old
critical/high Vitest/Vite-related dependency chain. Lockfile audit after upgrade:

- Production (`npm audit --omit=dev`): **0 advisories**.
- Full graph: **8 moderate, 0 high, 0 critical**.
- Remaining chain: electron-builder / app-builder-lib / dmg-builder /
  electron-builder-squirrel-windows -> @electron/get -> global-agent -> roarr
  -> sprintf-js, including GHSA-hp3w-g68c-fv3c (unbounded format precision DoS).
- These are build/package tooling, not served partner-page bundle inputs.
  Do not pass untrusted format strings into build tooling. Recheck before
  every release; do not force a builder downgrade merely to silence audit.

`npm audit` does not cover Chromium/Electron runtime advisories, Rust advisories
or all supply-chain risks. Keep the runtime current and review upstream
security releases. Build notices fail on unknown missing licence files; NAPI
crate archives omit their MIT licence, so the verified upstream licence is
vendored with source-revision provenance in the notices generator.
