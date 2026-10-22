# Security and private reports

AACpipe is an **experimental LOCAL-mode preview**, for trusted private networks
and the AAC device's own hotspot. It is not safe against an active attacker on
the network. HTTP delivery of the partner page means an attacker could replace
the page, steal a pairing credential, and read future messages. Application
encryption does not remove this bootstrap risk. Do not expose AACpipe to the
internet, use port forwarding, or use it on untrusted public/guest Wi-Fi.

The native pairing window uses a random session capability in an HttpOnly,
SameSite cookie; loopback access alone does not authorize management. This is
not intended to protect against malware running as the same Windows user.

## Reporting

When available, use [GitHub private vulnerability reporting](https://github.com/simonjudge/AACpipe/security/advisories/new).
Do not open a public issue containing an exploit, QR code, pairing URL, password
or conversation. If the private-report button is not available, do not post
details publicly: the maintainer must enable a private reporting channel before
accepting security reports for a public release.

Only the latest preview is maintained; there is no guaranteed response time.
Use synthetic text and dummy pairings for reproductions. See
[privacy](docs/privacy.md) and [release gates](docs/release-checklist.md).

## Before a broader supported release

- Add authenticated HTTPS/WSS or an independently authenticated installed
  receiver/bootstrap with verified Publisher identity.
- Review and test the security boundaries again after that change.
- Do not describe this preview as secure against active network attackers.
