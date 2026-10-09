# Grid 3 test cell actions

This is the Milestone 7 authoring checklist for the first AACpipe test grid.
The bridge is intentionally flag-driven and does not scrape Grid 3 state.

| Cell                     | Grid 3 action order                                                   | Bridge invocation                                          |
| ------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| Word                     | Copy the new word to the clipboard, then run the bridge               | `aacpipe-bridge.exe --word`                                |
| Punctuation              | Copy punctuation, then run the bridge                                 | `aacpipe-bridge.exe --word`                                |
| Prediction/edited phrase | Copy the complete message bar, then run the bridge                    | `aacpipe-bridge.exe --sentence`                            |
| Delete                   | Copy the complete message bar after deletion, then run the bridge     | `aacpipe-bridge.exe --sentence`                            |
| Speak                    | Copy the complete message bar, then run the bridge, then invoke speak | `aacpipe-bridge.exe --sentence --speak`                    |
| Clear                    | Run the bridge after clearing the message bar                         | `aacpipe-bridge.exe --clear`                               |
| Pair                     | Run the bridge with the selected channel type and label               | `aacpipe-bridge.exe --pair --persistent --label "Partner"` |
| Revoke                   | Run the bridge for one channel or all channels                        | `aacpipe-bridge.exe --revoke --channel <channel-id>`       |

`--word` is append-only. Any operation that changes earlier text must use
`--sentence` so the browser receives an authoritative resynchronisation.
Speak cells should send the complete sentence before entering the speaking
state. Pairing and revocation do not clear composition content; `--clear`
clears content without revoking pairing.

The bridge must be configured as a silent run-program action. If clipboard
copying and program execution are separate Grid 3 actions, copy must complete
before the bridge action starts.
