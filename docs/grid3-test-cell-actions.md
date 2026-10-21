# Grid 3 test cell actions

This is the Milestone 7 authoring checklist for the first AACpipe test grid.
The bridge is intentionally flag-driven and does not scrape Grid 3 state.
For the packaged trial, start AACpipe from its shortcut and wait for the pairing
window before testing cells. The bridge can auto-start it if needed, but a cold
Publisher launch is slower than a warm command.

In the pairing window, first try the **Recommended: stable .local address**
QR code. If the partner's device cannot open it, use an **IP-address fallback**
QR for the network both devices share. Grid's bridge commands are unchanged.
Test both home Wi-Fi and the Windows hotspot; `.local` needs multicast DNS
support on the network. Changing between `.local` and an IP link requires
scanning the QR again.

| Cell                     | Grid 3 action order                                                   | Bridge invocation                                          |
| ------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| Word                     | Copy the new word to the clipboard, then run the bridge               | `aacpipe-bridge.exe --word`                                |
| Punctuation              | Copy punctuation, then run the bridge                                 | `aacpipe-bridge.exe --word`                                |
| Prediction/edited phrase | Copy the complete message bar, then run the bridge                    | `aacpipe-bridge.exe --sentence`                            |
| Delete                   | Copy the complete message bar after deletion, then run the bridge     | `aacpipe-bridge.exe --sentence`                            |
| Speak                    | Copy the complete message bar, then run the bridge, then invoke speak | `aacpipe-bridge.exe --sentence --speak`                    |
| Clear                    | Run the bridge after clearing the message bar                         | `aacpipe-bridge.exe --clear`                               |
| Pair                     | Run the bridge with the selected channel type and label               | `aacpipe-bridge.exe --pair --persistent --label "Partner"` |
| One-time pair            | Run the bridge; the pairing window pops up with a one-time QR code    | `aacpipe-bridge.exe --pair --ephemeral`                    |
| Revoke                   | Run the bridge for one labelled channel or all channels               | `aacpipe-bridge.exe --revoke --label "Partner"`            |
| Show pairing window      | Run the bridge                                                        | `aacpipe-bridge.exe --show`                                |
| Hide pairing window      | Run the bridge                                                        | `aacpipe-bridge.exe --hide`                                |

Word, sentence, speak and clear commands always hide the AACpipe pairing
window so it never covers Grid 3, including when the bridge has to start
AACpipe. Add `--show` to any command to bring the window forward afterwards
(for example `--pair --persistent --label "Mum" --show`), or `--hide` to keep
it out of the way (for example `--revoke --all --hide`). `-show` and `-hide`
with a single dash also work. A pair command shows the window unless `--hide`
is given.

`--word` is append-only. Any operation that changes earlier text must use
`--sentence` so the browser receives an authoritative resynchronisation.
Speak cells should send the complete sentence before entering the speaking
state. Pairing and revocation do not clear composition content; `--clear`
clears content without revoking pairing.

A one-time pairing ends as soon as its partner page disconnects (including a
page reload), when the AAC user selects its **Revoke** button, or when
AACpipe quits. It is never saved to disk. One-time pairings can also be started
from the **New one-time pairing** button in the pairing window or tray menu.

Pairing labels are unique, ignoring case, and identify the channel for
`--revoke --label`. Without `--label`, a persistent pairing is named
`Partner 1`, `Partner 2`, and so on, and a one-time pairing `One-time 1`,
`One-time 2`, and so on. Use `--revoke --all` to remove every pairing.

The bridge must be configured as a silent run-program action. If clipboard
copying and program execution are separate Grid 3 actions, copy must complete
before the bridge action starts.
