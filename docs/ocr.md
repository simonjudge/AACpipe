# Standalone OCR companion (experimental)

The optional Windows x64 OCR companion runs as **aacpipe-ocr.exe**, independently
of the Publisher/Electron process. It captures a selected AAC application window,
recognises selected text bands locally with Tesseract, and sends changed,
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

## Set up a message bar with symbols above its text

1. Start AACpipe and pair the partner normally.
2. Disable Grid/direct **content-producing** bridge actions. Pairing, status and
   management commands can remain. OCR must be the only composition writer.
3. Open the AAC app in its intended fixed-size layout. Select that window in
   OCR setup and click **Capture / recalibrate**.
4. Drag a rectangle around the **text underneath the symbols**, across the full
   width where words can appear. Leave the graphic symbols outside it. For
   multiple rows, draw one band per text row, in reading order. Up to twelve
   non-overlapping bands are supported; bands are ordered top-to-bottom then
   left-to-right. Include ascenders/descenders and punctuation, with a little
   margin, but not the symbol row. Use **Clear text bands** to start again.
5. Clear the AAC message. Click **Calibrate EMPTY text** and confirm that the
   selected bands contain no text or placeholder. The empty reference is kept
   only in memory. If a cursor blinks inside the band, choose a band excluding
   the cursor only if that does not clip text, or test calibration with the
   cursor in a stable state. Dynamic backgrounds may prevent automatic clearing.
6. Choose the updated bridge executable if needed, confirm the single-source
   checkbox, then click **Start / resume sharing**.
7. Compose and correct some invented messages. The read-only preview shows the
   latest readable text; status distinguishes recognition from bridge delivery.
   Save the profile if desired.

The module **does not identify or translate graphic symbols**. It excludes them
geometrically. This works when labels occupy predictable horizontal text bands.
Layouts where symbols overlap text, labels move unpredictably or individual
words alternate between different heights require a different layout or a
direct AAC integration. Do not widen bands to include symbols as a workaround.

## Behaviour and controls

- Samples at a maximum of four times per second; only one recognition/delivery
  operation is in flight. Actual frequency depends on device performance.
- Two matching observations confirm ordinary changes. Changed text is sent as
  a complete replacement, so deletion and corrections are not appended.
- Empty requires **both** a match to the calibrated blank pixels and repeated
  confirmation for at least 750 ms. No OCR text, low-confidence recognition or a
  black failed capture is not automatically an empty message.
- OCR confidence below 65% holds the last shared message and reports a warning.
  Confidence is an engine heuristic, not a correctness guarantee.
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

Capture uses Windows `PrintWindow` for the explicitly selected client area,
not a desktop screenshot. This avoids capturing an unrelated foreground window.
Some GPU-rendered applications do not support this capture method or render
stale/blank frames; the synthetic test cannot establish compatibility with a
particular AAC product. **Verify actual live typing and clearing on the intended
Grid/Mind Express/Communicator version and hardware.** Unsupported targets need
a future Windows Graphics Capture backend, not an automatic desktop fallback.

Keep the message bar's position, size, DPI, theme and row layout fixed. Changes
to window size are rejected, but same-size internal layout changes cannot be
detected reliably. Recalibrate after any such change. OCR reads only rendered
content: it cannot reconstruct clipped, scrolled-off or hidden earlier words.

Profiles remember application process name, window size, bands, language and
bridge path. On restart, explicitly select/capture the window and recalibrate;
the companion never silently attaches to another application. Profiles matching
the selected process name and dimensions can restore band geometry.

## Privacy

Recognition is offline. No analytics or OCR network service is used. Screenshots,
blank reference images and recognised text are kept in process memory only, not
saved or intentionally logged. The full selected window briefly exists in memory
before text-band cropping. Normal OS memory, crash dumps and forensic erasure
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
deduplication, UTF-8 limits, actual native-engine recognition with original
geometric symbols above text, multiple text rows, blank/failure distinction,
real Windows client-area capture, and subprocess stdin/status/failure/cancellation.
It uses a fake bridge child for isolated transport tests, not the user's live
Publisher or real messages. Rust tests cover CLI validation and stdin bounds.

Before using this on a real AAC device, additionally verify symbol-labelled
layouts, live corrections, cursor/highlight effects, dark themes, display
scaling, sleep/lock/resume, Publisher restart, pause/clear and recognition speed.
Target stable-edit latency is one second on the chosen device; this is not yet
a measured guarantee for AAC hardware.
