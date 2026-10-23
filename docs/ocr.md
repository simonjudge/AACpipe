# Standalone OCR companion (experimental)

The optional Windows x64 OCR companion runs as **aacpipe-ocr.exe**, independently
of the Publisher/Electron process. It captures a selected AAC application window,
recognises the text in a selected chat area locally with Tesseract (ignoring
graphic symbols), and sends changed,
authoritative sentence snapshots through **aacpipe-bridge.exe**. It never uses
the clipboard, sends speech events, or changes the AAC application.

This is an experimental fixed-layout integration, not a replacement for a direct
AAC integration or the user's normal communication route. OCR can make confident
mistakes. Test with invented messages before sharing real communication.

## Build and run

Build prerequisites, in addition to [normal development tools](development.md):

- .NET SDK 8 or 9, with Windows Desktop targeting support.
- Internet access at build time for NuGet, the self-contained .NET runtime and
  the checksum-pinned English Tesseract model.
- The native Tesseract binaries require the Microsoft Visual C++ 2015-2022 x64
  runtime. Install Microsoft's official redistributable if it is not already
  available. No Python, separately installed Tesseract, or installed .NET runtime
  is required to run the published companion.

```powershell
npm run ocr:build
.\release\aacpipe-ocr\aacpipe-ocr.exe
```

Distribute the **entire** `release\aacpipe-ocr` directory, including `x64`,
`tessdata`, .NET runtime files, notices and the updated bridge, not just the exe.
This is a separate unsigned portable development build; it does not change the
existing AACpipe installer. Run the usual installed AACpipe Publisher separately.
The included bridge deliberately **does not auto-start or restart** AACpipe.
Quitting the Publisher must not cause OCR to launch it again.

The English model is bundled. For other languages, supply compatible
`tessdata_fast` language files under the companion's `tessdata` directory and
select their Tesseract names, e.g. `eng+fra`. Language downloads are an explicit
installation step; the running companion never downloads models.

## Set up a message bar with symbols

1. Start AACpipe and pair the partner normally.
2. Disable Grid/direct **content-producing** bridge actions. Pairing, status and
   management commands can remain. OCR must be the only composition writer.
3. Open the AAC app in its intended fixed-size layout. Select that window in
   OCR setup and click **Capture / recalibrate**.
4. Drag **one rectangle around the whole chat area**: every line, symbols and
   labels included, with a small margin, across the full width where words can
   appear. Normally a single rectangle is all you need. (Up to twelve
   non-overlapping areas are supported for split layouts; they are read
   top-to-bottom then left-to-right.) Use **Clear chat area** to start again.
5. Clear the AAC message. Click **Calibrate EMPTY text** and confirm that the
   selected area contains no text, symbols or placeholder. The empty reference
   is kept only in memory. A thin blinking text cursor is tolerated. Dynamic
   backgrounds may prevent automatic clearing.
6. Choose the updated bridge executable if needed, confirm the single-source
   checkbox, then click **Start / resume sharing**.
7. Compose and correct some invented messages. The read-only preview shows the
   latest readable text; status distinguishes recognition from bridge delivery.
   Save the profile if desired.

### How symbols are ignored

The module **does not identify or translate graphic symbols**; only the text
labels are shared. On each frame:

1. Pixels that differ from the empty reference are grouped into connected
   shapes. **Text lines** are found from the layout: runs of similar-sized,
   thin-stroked shapes sitting side by side the way letters do. Filled or
   thick shapes (most symbol artwork) cannot start a text line.
2. Everything that is not on a text line, or is much taller than its letters,
   is painted with the background colour before OCR. This removes whole symbols
   and also their small detached parts (sparkles, speech bubbles, motion lines).
3. Letters on each line are grouped into words by the gaps between them, and
   every word is read by Tesseract. **Every word must be read confidently**
   (60% or more); otherwise the frame is refused and the last shared text is
   held, rather than silently dropping or merging words. Lines are read
   top-to-bottom, words left-to-right.
4. For English, a word that is one plain upright stroke is taken as "I"
   (Tesseract often guesses l, 1, ! or | for it). A thin upright stroke after
   the last word of the bottom line is treated as the text cursor and ignored,
   so a lone "I" typed as the very last word is shared once the next word appears.

This was tuned against real Grid 3 (Voco Chat) labels and Widgit symbols.
If the area changed but contains no readable text (for example symbols only),
the last shared text is held and a warning is shown; this never clears the
partner display. Limitations: labels touching or overlapping their symbol may
be removed with it; symbols drawn at text size in thin lines may be refused as
unreadable text; labels much larger or smaller than the rest of the text may
be ignored; a message made only of one-letter words (for example just "I")
has no recognisable text line and is held until more is typed. Dark themes are
untested. Test with your own symbol set
and font size.

## Behaviour and controls

- Samples at a maximum of four times per second; only one recognition/delivery
  operation is in flight. Actual frequency depends on device performance.
- Two matching observations confirm ordinary changes. Changed text is sent as
  a complete replacement, so deletion and corrections are not appended.
- Empty requires **both** a match to the calibrated blank pixels and repeated
  confirmation for at least 750 ms. No OCR text, low-confidence recognition or a
  black failed capture is not automatically an empty message.
- Any word on a text line with OCR confidence below 60% holds the last
  shared message and reports a warning. Confidence is an engine heuristic, not a
  correctness guarantee.
- Unchanged text generates no extra content commands. A status probe approximately
  every two seconds checks the bridge and detects unexpected composition
  state/revision changes. This is a safeguard, **not an atomic source lock**:
  do not enable concurrent Grid and OCR updates.
- A bridge failure or unexpected Publisher state change pauses sharing.
  Resume re-observes and republishes fresh stable text, never an old edit queue.
- Hidden/minimised/closed windows, resizing, unreadable text and invalid crops
  do not produce clear commands. **The last shared message remains visible**.
  Restore/recalibrate the source as needed, or explicitly clear it.
- **Pause (keep text)** stops future observations. An already submitted bridge
  request may finish; pause cannot retract a request already accepted.
- **Stop and clear** pauses and explicitly clears the partner display. It needs
  a running Publisher. If an operation is still finishing, the UI reports this;
  clear after it finishes.
- Closing the setup window leaves the companion in the tray. The tray exposes
  Show, Pause, Stop and clear, and Quit. Quit offers to clear first.
- Text over AACpipe's 4096-byte retained-buffer limit is refused visibly rather
  than allowing silent loss of the beginning of the message.

## Capture and layout limitations

During setup the AAC window is brought to the front and its client area is
copied from the screen. Windows `PrintWindow` (which works even while the
window is partly covered) is also tried, and used only if it matches the
screen. **Grid 3 does not support it**: its window is drawn with DirectComposition
(`WS_EX_NOREDIRECTIONBITMAP`) and `PrintWindow` is refused with access denied.
Such applications use **screen capture** of the window's client area, and the
status line says so. If window capture stops working later, sharing switches
to screen capture automatically instead of failing:

- The OCR window hides itself briefly while capturing during setup, and
  minimises when sharing starts. Grid is brought to the front for setup.
- The chosen chat area must stay **visible and uncovered** while sharing. Before
  and after every frame, a grid of points across the selected area is checked to
  belong to the AAC window (or its own popups). If another window, including the
  AACpipe Publisher or OCR setup window, covers the area, the frame is refused
  and nothing is sent; the last shared text stays visible.
- A locked or sleeping screen cannot be captured; sharing waits with a warning.

The synthetic tests cannot establish compatibility with a particular AAC
product. **Verify actual live typing and clearing on the intended
Grid/Mind Express/Communicator version and hardware.**

Keep the message bar's position, size, DPI, theme and row layout fixed. Changes
to window size are rejected, but same-size internal layout changes cannot be
detected reliably. Recalibrate after any such change. OCR reads only rendered
content: it cannot reconstruct clipped, scrolled-off or hidden earlier words.

Profiles remember application process name, window size, chat areas, language and
bridge path. On restart, explicitly select/capture the window and recalibrate;
the companion never silently attaches to another application. Profiles matching
the selected process name and dimensions can restore the chat-area geometry.

## Privacy

Recognition is offline. No analytics or OCR network service is used. Screenshots,
blank reference images and recognised text are kept in process memory only, not
saved or intentionally logged. The full selected window briefly exists in memory
before chat-area cropping. In screen-capture mode, the copied pixels are the
visible screen contents of that window's client area only. Normal OS memory, crash dumps and forensic erasure
limitations still apply. The live setup/preview can expose message content to
someone looking at the AAC device.

Configuration is stored in `%LOCALAPPDATA%\AACpipe.Ocr\profile.json`, separately
from Publisher pairing data. No screenshots, empty references or message history
are saved there. Text travels to the bridge through redirected UTF-8 stdin,
not process command-line arguments. AACpipe's existing
[local-network trust limitations](privacy.md) still apply.

## Bridge additions

Existing Grid commands retain their defaults. New optional flags:

| Flag | Meaning |
| --- | --- |
| `--text-stdin` | Read bounded, strict UTF-8 text until EOF for `--sentence` or `--word`; mutually exclusive with `--text`. No clipboard fallback. |
| `--preserve-window` | Do not change Publisher window visibility; mutually exclusive with `--show` and `--hide`. |
| `--no-autostart` | Fail if Publisher IPC is unavailable instead of launching the Publisher. |
| `--json` | Emit the successful v1 IPC response on stdout; failures retain existing nonzero exit codes. |

Input retains the existing limits: 256 UTF-8 bytes per word, 65536 per sentence,
and the existing 128 KiB JSON IPC-frame limit. `--clear` is used for empty text
because the CLI intentionally refuses empty `--sentence` input.

## Validation

```powershell
npm run ocr:build
npm run ocr:test
```

The executable test harness checks stabilisation and exact blank timing,
deduplication, UTF-8 limits, text-line/word layout and symbol erasing, actual native-engine
recognition of a Grid-like two-line chat bar with original geometric symbols
above each label (including a lone "I"), symbol-only refusal, cursor tolerance,
blank/failure distinction, real Windows window and screen capture with an
occlusion check, and subprocess stdin/status/failure/cancellation.
It uses a fake bridge child for isolated transport tests, not the user's live
Publisher or real messages. Rust tests cover CLI validation and stdin bounds.

Before using this on a real AAC device, additionally verify symbol-labelled
layouts, live corrections, cursor/highlight effects, dark themes, display
scaling, sleep/lock/resume, Publisher restart, pause/clear and recognition speed.
Target stable-edit latency is one second on the chosen device; this is not yet
a measured guarantee for AAC hardware.
