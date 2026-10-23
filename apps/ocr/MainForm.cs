using System.Diagnostics;
using System.Text.RegularExpressions;

namespace AACpipe.Ocr;

internal sealed class MainForm : Form
{
    private readonly ComboBox windows = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 320 };
    private readonly TextBox language = new() { Text = "eng", Width = 80 };
    private readonly TextBox bridgePath = new() { Width = 360 };
    private readonly BandSelector selector = new() { Dock = DockStyle.Fill };
    private readonly TextBox preview = new() { Dock = DockStyle.Bottom, Height = 65, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical };
    private readonly Label status = new() { Dock = DockStyle.Bottom, Height = 58, Text = "Choose the AAC window. Only selected text bands will be recognised.", Padding = new Padding(5) };
    private readonly CheckBox soleSource = new() { Text = "Grid/direct content updates are disabled; OCR is the only composition source.", AutoSize = true };
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 250 };
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly TextTracker tracker = new();
    private readonly List<Control> setupControls = [];
    private readonly Button start;
    private readonly NotifyIcon tray;
    private readonly CancellationTokenSource lifetime = new();
    private WindowTarget? target;
    private Size captureSize;
    private List<byte[]>? blankBands;
    private Recognizer? recognizer;
    private OcrProfile? profile;
    private bool sharing;
    private bool busy;
    private bool exiting;
    private int generation;
    private TimeSpan retryAfter;
    private TimeSpan lastProbe;
    private BridgeSnapshot? acknowledgedSnapshot;

    internal MainForm()
    {
        Text = "AACpipe OCR - local text-band capture";
        Size = new Size(1080, 760);
        MinimumSize = new Size(850, 620);
        var setup = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(5) };
        AddSetup(setup, windows);
        AddSetup(setup, Button("Refresh windows", RefreshWindows));
        AddSetup(setup, Button("Capture / recalibrate", CaptureSelection));
        AddSetup(setup, Button("Clear text bands", () => selector.ClearBands()));
        AddSetup(setup, new Label { Text = "Language:", AutoSize = true, Padding = new Padding(0, 7, 0, 0) });
        AddSetup(setup, language);
        AddSetup(setup, Button("Calibrate EMPTY text", Calibrate));
        AddSetup(setup, Button("Save profile", SaveProfile));
        var bridgeRow = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(5) };
        AddSetup(bridgeRow, new Label { Text = "Bridge:", AutoSize = true, Padding = new Padding(0, 7, 0, 0) });
        AddSetup(bridgeRow, bridgePath);
        AddSetup(bridgeRow, Button("Browse...", BrowseBridge));
        AddSetup(bridgeRow, soleSource);
        var controls = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(5) };
        start = Button("Start / resume sharing", StartSharing);
        controls.Controls.Add(start);
        controls.Controls.Add(Button("Pause (keep text)", () => Pause("Paused. The partner still sees the last shared text. Use Stop and clear to remove it.")));
        controls.Controls.Add(Button("Stop and clear", StopAndClear));
        controls.Controls.Add(Button("Quit", Quit));
        var help = new Label
        {
            Dock = DockStyle.Top,
            Height = 58,
            Padding = new Padding(5),
            Text = "1. Capture the AAC window.  2. Drag a band around EACH text row, below any graphic symbols.\n" +
                "3. Clear the AAC message and calibrate EMPTY text.  4. Start AACpipe and enable sharing. " +
                "Do not resize/reflow the AAC layout. Closing this window leaves OCR in the tray."
        };
        Controls.Add(selector);
        Controls.Add(preview);
        Controls.Add(status);
        Controls.Add(help);
        Controls.Add(controls);
        Controls.Add(bridgeRow);
        Controls.Add(setup);
        selector.BandsChanged += () => { blankBands = null; status.Text = $"{selector.Bands.Count} text band(s). Calibrate with an empty AAC message."; };
        timer.Tick += async (_, _) => await Tick();
        var menu = new ContextMenuStrip();
        menu.Items.Add("Show setup", null, (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); });
        menu.Items.Add("Pause (keep text)", null, (_, _) => Pause("Paused from tray. Last shared text remains on the partner display."));
        menu.Items.Add("Stop and clear", null, async (_, _) => await StopAndClear());
        menu.Items.Add("Quit", null, async (_, _) => await Quit());
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "AACpipe OCR: paused", Visible = true, ContextMenuStrip = menu };
        tray.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Normal; Activate(); };
        FormClosing += (_, e) =>
        {
            if (exiting) return;
            e.Cancel = true;
            Hide();
        };
        FormClosed += (_, _) =>
        {
            lifetime.Cancel();
            timer.Dispose();
            tray.Dispose();
            if (!busy) recognizer?.Dispose();
        };
        bridgePath.Text = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "AACpipe", "aacpipe-bridge.exe");
        if (File.Exists(Path.Combine(AppContext.BaseDirectory, "aacpipe-bridge.exe")))
            bridgePath.Text = Path.Combine(AppContext.BaseDirectory, "aacpipe-bridge.exe");
        try
        {
            profile = OcrProfile.Load();
            if (profile is not null)
            {
                language.Text = profile.Language;
                bridgePath.Text = profile.BridgePath;
            }
            RefreshWindows();
        }
        catch (Exception error) { Report(error); }
    }

    private void AddSetup(FlowLayoutPanel panel, Control control)
    {
        panel.Controls.Add(control);
        setupControls.Add(control);
    }

    private Button Button(string text, Action action) => Button(text, () => { action(); return Task.CompletedTask; });

    private Button Button(string text, Func<Task> action)
    {
        var button = new Button { Text = text, AutoSize = true };
        button.Click += async (_, _) =>
        {
            try { await action(); }
            catch (Exception error) { Report(error); }
        };
        return button;
    }

    private void RefreshWindows()
    {
        windows.DataSource = WindowCapture.ListWindows();
    }

    private void BrowseBridge()
    {
        using var dialog = new OpenFileDialog { Filter = "AACpipe bridge|aacpipe-bridge.exe", CheckFileExists = true };
        if (dialog.ShowDialog(this) == DialogResult.OK) bridgePath.Text = dialog.FileName;
    }

    private async Task CaptureSelection()
    {
        if (busy) throw new InvalidOperationException("Wait for the current capture to finish.");
        target = windows.SelectedItem as WindowTarget ?? throw new InvalidOperationException("Select the AAC window first.");
        blankBands = null;
        selector.ClearBands();
        var frame = await CaptureForSetup(target);
        captureSize = frame.Size;
        selector.SetImage(frame);
        using var process = Process.GetProcessById((int)target.ProcessId);
        if (profile is not null && profile.ProcessName == process.ProcessName &&
            profile.Width == frame.Width && profile.Height == frame.Height)
        {
            selector.Bands.AddRange(profile.Bands);
            selector.Invalidate();
        }
        status.Text = "Drag one rectangle around each text row, excluding graphic symbols. Then clear the AAC message and calibrate EMPTY text.";
    }

    private async Task Calibrate()
    {
        var selected = target ?? throw new InvalidOperationException("Capture the AAC window first.");
        if (selector.Bands.Count == 0) throw new InvalidOperationException("Drag at least one text band first.");
        if (MessageBox.Show(this, "Is the AAC message EMPTY, with no text or placeholder inside the selected bands?\n" +
            "The current band images become the blank reference. Symbols must be outside the bands.",
            "Confirm empty message", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        using var frame = await CaptureForSetup(selected, captureSize);
        blankBands = Recognizer.Calibrate(frame, selector.Bands);
        status.Text = "Empty reference calibrated in memory. Start AACpipe, disable other content sources, then start sharing.";
    }

    private async Task<Bitmap> CaptureForSetup(WindowTarget selected, Size? size = null)
    {
        busy = true;
        UpdateControls();
        var capture = Task.Run(() => WindowCapture.Capture(selected, size));
        try { return await capture.WaitAsync(TimeSpan.FromSeconds(3)); }
        catch
        {
            // PrintWindow can block inside another application. Do not allow overlapping captures.
            status.Text = "Capture did not complete. Waiting for the selected application; no text is being sent.";
            try { using var abandoned = await capture; }
            catch (Exception error) { Report(error); }
            throw;
        }
        finally { busy = false; if (!IsDisposed) UpdateControls(); }
    }

    private void SaveProfile()
    {
        var selected = target ?? throw new InvalidOperationException("Capture the AAC window first.");
        if (selector.Bands.Count == 0) throw new InvalidOperationException("Select text bands first.");
        using var process = Process.GetProcessById((int)selected.ProcessId);
        profile = new OcrProfile(process.ProcessName, captureSize.Width, captureSize.Height,
            selector.Bands.ToArray(), language.Text.Trim(), Path.GetFullPath(bridgePath.Text));
        profile.Save();
        status.Text = "Profile saved. Images and recognised text are not saved. Empty calibration is required after restart.";
    }

    private void StartSharing()
    {
        if (sharing) return;
        if (busy) throw new InvalidOperationException("Wait for the current capture or bridge command to finish.");
        if (target is null || blankBands is null) throw new InvalidOperationException("Capture, select text bands and calibrate EMPTY text first.");
        if (!soleSource.Checked) throw new InvalidOperationException("Disable other content sources and confirm OCR is the only source.");
        if (!File.Exists(bridgePath.Text)) throw new FileNotFoundException("Choose the updated aacpipe-bridge.exe first.");
        if (!Regex.IsMatch(language.Text, @"^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$"))
            throw new InvalidOperationException("Use a Tesseract language name, for example eng or eng+fra.");
        recognizer?.Dispose();
        recognizer = null;
        recognizer = new Recognizer(Path.Combine(AppContext.BaseDirectory, "tessdata"), language.Text);
        tracker.Resynchronize();
        selector.SetImage(null);
        preview.Text = "";
        sharing = true;
        generation++;
        retryAfter = TimeSpan.Zero;
        lastProbe = TimeSpan.MinValue;
        acknowledgedSnapshot = null;
        status.Text = "Sharing enabled. OCR may make mistakes. No speech events will be inferred.";
        tray.Text = "AACpipe OCR: sharing";
        UpdateControls();
        timer.Start();
    }

    private void Pause(string message)
    {
        sharing = false;
        generation++;
        timer.Stop();
        tracker.Invalidate();
        status.Text = message;
        tray.Text = "AACpipe OCR: paused";
        UpdateControls();
    }

    private async Task StopAndClear()
    {
        Pause("Stopping OCR...");
        if (busy) throw new InvalidOperationException("OCR is paused. Wait for the in-flight operation, then press Stop and clear again.");
        busy = true;
        UpdateControls();
        try
        {
            await new BridgeClient(bridgePath.Text).SendAsync("", lifetime.Token);
            tracker.Resynchronize();
            preview.Text = "";
            status.Text = "Stopped. The partner display was cleared.";
        }
        finally { busy = false; UpdateControls(); }
    }

    private async Task Tick()
    {
        if (!sharing || busy || clock.Elapsed < retryAfter) return;
        busy = true;
        UpdateControls();
        var session = generation;
        var selected = target!;
        var reader = recognizer!;
        var bands = selector.Bands.ToArray();
        var blanks = blankBands!;
        var work = Task.Run(() =>
        {
            using var frame = WindowCapture.Capture(selected, captureSize);
            return reader.Read(frame, bands, blanks);
        });
        try
        {
            var text = await work.WaitAsync(TimeSpan.FromSeconds(3), lifetime.Token);
            if (!sharing || session != generation) return;
            if (lastProbe == TimeSpan.MinValue || clock.Elapsed - lastProbe >= TimeSpan.FromSeconds(2))
            {
                var snapshot = await new BridgeClient(bridgePath.Text).ProbeAsync(lifetime.Token);
                if (!sharing || session != generation) return;
                lastProbe = clock.Elapsed;
                if (acknowledgedSnapshot is not null && snapshot != acknowledgedSnapshot)
                {
                    Pause("AACpipe's composition changed or restarted. Disable competing sources and resume to resynchronise. Nothing was overwritten.");
                    return;
                }
            }
            preview.Text = text;
            var update = tracker.Observe(text, clock.Elapsed);
            if (update is null) return;
            try
            {
                acknowledgedSnapshot = await new BridgeClient(bridgePath.Text).SendAsync(update, lifetime.Token);
            }
            catch
            {
                tracker.Resynchronize();
                throw;
            }
            tracker.Acknowledge(update);
            status.Text = "Sharing: latest stable text acknowledged by AACpipe. Graphic symbols are not sent.";
        }
        catch (OperationCanceledException) when (exiting) { }
        catch (Exception error)
        {
            tracker.Invalidate();
            retryAfter = clock.Elapsed + TimeSpan.FromSeconds(2);
            if (error is IOException or TimeoutException)
                Pause("Sharing paused: " + error.Message + " Last shared text remains visible. Resume to resynchronise.");
            else
            {
                status.Text = "Not sending: " + error.Message + " Last shared text remains visible.";
                tray.Text = "AACpipe OCR: check capture";
            }
        }
        finally
        {
            if (!work.IsCompleted)
            {
                try { await work; }
                catch (Exception error) { if (!exiting) Report(error); }
            }
            busy = false;
            if (exiting) reader.Dispose();
            else if (!IsDisposed) UpdateControls();
        }
    }

    private async Task Quit()
    {
        var choice = MessageBox.Show(this, "Clear the partner display before quitting?\nYes: stop and clear. No: leave the last shared text. Cancel: keep OCR open.",
            "Quit AACpipe OCR", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
        if (choice == DialogResult.Cancel) return;
        if (choice == DialogResult.Yes) await StopAndClear();
        Pause("Stopped.");
        exiting = true;
        Close();
    }

    private void UpdateControls()
    {
        foreach (var control in setupControls) control.Enabled = !sharing && !busy;
        selector.Enabled = !sharing && !busy;
        start.Enabled = !sharing && !busy;
    }

    private void Report(Exception error)
    {
        if (exiting) return;
        status.Text = "Error: " + error.Message;
        tray.Text = "AACpipe OCR: action needed";
    }
}
