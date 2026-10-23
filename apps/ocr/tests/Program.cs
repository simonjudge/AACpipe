using System.Diagnostics;
using System.Drawing;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using AACpipe.Ocr;

internal static class Program
{
    private static int passed;

    [STAThread]
    private static int Main(string[] args)
    {
        // The same executable is a deterministic child-process bridge fixture.
        if (args.Contains("--json")) return FakeBridge(args);
        try
        {
            TestTracker();
            TestBridgeParsing();
            TestBridgeTransport().GetAwaiter().GetResult();
            var modelPath = args.Length > 0 ? Path.GetFullPath(args[0]) : throw new ArgumentException("Pass the tessdata directory.");
            TestRecognition(modelPath);
            TestWindowCapture();
            Console.WriteLine($"PASS: {passed} assertions (tracking, bridge, actual OCR, symbol exclusion, capture).");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void Check(bool result, string name)
    {
        if (!result) throw new InvalidOperationException("FAIL: " + name);
        passed++;
    }

    private static void Throws<T>(Action action, string name) where T : Exception
    {
        try { action(); }
        catch (T) { passed++; return; }
        throw new InvalidOperationException("FAIL: " + name);
    }

    private static void TestTracker()
    {
        var tracker = new TextTracker();
        Check(tracker.Observe("Hello", TimeSpan.Zero) is null, "first observation is not published");
        Check(tracker.Observe("Hello", TimeSpan.FromMilliseconds(250)) == "Hello", "two matching observations publish");
        tracker.Acknowledge("Hello");
        for (var i = 2; i < 100; i++)
            Check(tracker.Observe("Hello", TimeSpan.FromMilliseconds(i * 250)) is null, "identical text sends nothing");
        Check(tracker.Observe("Hell", TimeSpan.FromSeconds(25)) is null, "deletion needs confirmation");
        Check(tracker.Observe("Hell", TimeSpan.FromSeconds(25.25)) == "Hell", "confirmed deletion replaces text");
        tracker.Acknowledge("Hell");
        Check(tracker.Observe("", TimeSpan.FromSeconds(26)) is null, "blank is not immediately cleared");
        Check(tracker.Observe("", TimeSpan.FromSeconds(26.25)) is null, "blank needs longer confirmation");
        Check(tracker.Observe("", TimeSpan.FromSeconds(26.75)) == "", "blank clears at 750ms");
        tracker.Invalidate();
        Check(tracker.Observe("", TimeSpan.FromSeconds(27)) is null, "failure resets blank confirmation");
        tracker.Acknowledge("Again");
        tracker.Resynchronize();
        Check(tracker.Observe("Again", TimeSpan.FromSeconds(30)) is null, "resume reobserves");
        Check(tracker.Observe("Again", TimeSpan.FromSeconds(30.25)) == "Again", "resume republishes identical current text");
        tracker.Invalidate();
        tracker.Observe("Slow", TimeSpan.FromSeconds(40));
        Check(tracker.Observe("Slow", TimeSpan.FromSeconds(42)) is null, "long observation gap resets evidence");
        Check(TextTracker.Normalize("  Hello\n  partner\t ") == "Hello partner", "normalise like Publisher");
        Throws<InvalidOperationException>(() => tracker.Observe(new string('a', 4097), TimeSpan.Zero), "byte limit");
        Throws<InvalidOperationException>(() => tracker.Observe(new string('\u65e5', 1366), TimeSpan.Zero), "UTF-8 byte limit");
    }

    private static void TestBridgeParsing()
    {
        Check(BridgeClient.ParseSnapshot("""{"v":1,"ok":true,"state":"IDLE","revision":"0"}""") == new BridgeSnapshot("IDLE", "0"), "parse snapshot");
        foreach (var json in new[]
        {
            "{}", "not JSON", """{"v":1,"ok":false}""",
            """{"v":1,"ok":true,"state":"OTHER","revision":"0"}""",
            """{"v":1,"ok":true,"state":"IDLE","revision":"01"}""",
            """{"v":1,"ok":true,"state":"IDLE","revision":"18446744073709551616"}"""
        }) Throws<IOException>(() => BridgeClient.ParseSnapshot(json), "reject invalid bridge snapshot");
    }

    private static async Task TestBridgeTransport()
    {
        var path = Environment.ProcessPath ?? throw new InvalidOperationException("Missing test executable path.");
        var bridge = new BridgeClient(path);
        var sentence = "Quotes \"hello\" \u65e5\u672c\u8a9e\nnew line";
        var snapshot = await bridge.SendAsync(sentence, CancellationToken.None);
        Check(snapshot.Revision == Encoding.UTF8.GetByteCount(sentence).ToString(), "stdin preserves Unicode, quotes, newlines and has no BOM");
        Check((await bridge.SendAsync("", CancellationToken.None)).State == "IDLE", "blank sends clear");
        Check((await bridge.ProbeAsync(CancellationToken.None)).Revision == "42", "status probe");
        try
        {
            await bridge.SendAsync("REFUSE", CancellationToken.None);
            throw new InvalidOperationException("Bridge refusal was ignored.");
        }
        catch (IOException) { passed++; }
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(150));
        try
        {
            await bridge.SendAsync("WAIT", cancel.Token);
            throw new InvalidOperationException("Bridge cancellation was ignored.");
        }
        catch (OperationCanceledException) { passed++; }
    }

    private static int FakeBridge(string[] args)
    {
        if (!args.Contains("--preserve-window") || !args.Contains("--no-autostart")) return 2;
        var text = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: false).ReadToEnd();
        if (text == "REFUSE") return 6;
        if (text == "WAIT") Thread.Sleep(10000);
        var status = args.Contains("--status");
        var clear = args.Contains("--clear");
        if (!clear && !status && !args.Contains("--text-stdin")) return 2;
        if (args.Contains("--speak") || args.Contains("--text")) return 2;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            v = 1,
            ok = true,
            state = clear || status ? "IDLE" : "COMPOSING",
            revision = status ? "42" : Encoding.UTF8.GetByteCount(text).ToString()
        }));
        return 0;
    }

    private static void TestRecognition(string modelPath)
    {
        using var empty = new Bitmap(900, 240);
        using (var graphics = Graphics.FromImage(empty)) graphics.Clear(Color.White);
        var bands = new[] { new Rectangle(10, 100, 870, 65), new Rectangle(10, 170, 870, 65) };
        var blanks = Recognizer.Calibrate(empty, bands);
        using var recognizer = new Recognizer(modelPath, "eng");
        Check(recognizer.Read(empty, bands, blanks) == "", "calibrated blank is empty");
        using var frame = (Bitmap)empty.Clone();
        using (var graphics = Graphics.FromImage(frame))
        {
            // Original geometric test symbols, not third-party symbol artwork.
            graphics.FillEllipse(Brushes.Red, 50, 10, 70, 70);
            graphics.FillRectangle(Brushes.Blue, 190, 10, 70, 70);
            using var font = new Font("Arial", 30, FontStyle.Regular, GraphicsUnit.Pixel);
            graphics.DrawString("NOT THE MESSAGE", font, Brushes.Black, 320, 20);
            graphics.DrawString("Hello partner", font, Brushes.Black, 15, 108);
            graphics.DrawString("I need a drink", font, Brushes.Black, 15, 178);
        }
        var recognised = recognizer.Read(frame, bands, blanks);
        Check(recognised.Contains("Hello partner", StringComparison.Ordinal), $"first text row is recognised (actual: {recognised})");
        Check(recognised.Contains("need a drink", StringComparison.Ordinal), $"second text row is recognised (actual: {recognised})");
        Check(!recognised.Contains("NOT THE MESSAGE", StringComparison.Ordinal), $"text above the selected bands is excluded (actual: {recognised})");
        using var correction = (Bitmap)empty.Clone();
        using (var graphics = Graphics.FromImage(correction))
        {
            using var font = new Font("Arial", 30, FontStyle.Regular, GraphicsUnit.Pixel);
            graphics.DrawString("Hello", font, Brushes.Black, 15, 108);
        }
        Check(recognizer.Read(correction, bands, blanks) == "Hello", "deletion and blank second row");
        using var failed = new Bitmap(900, 240);
        using (var graphics = Graphics.FromImage(failed)) graphics.Clear(Color.Black);
        Throws<InvalidOperationException>(() => recognizer.Read(failed, bands, blanks), "black failed capture is not clear");
        var changed = blanks[0].ToArray();
        changed[100] = 0;
        Check(!Recognizer.MatchesBlank(changed, blanks[0]), "a small mark prevents blank classification");
        Throws<InvalidOperationException>(() => recognizer.Read(frame, [], []), "missing calibration is an error");
    }

    private static void TestWindowCapture()
    {
        using var form = new Form { Text = "AACpipe OCR synthetic capture test", ClientSize = new Size(500, 200), ShowInTaskbar = false };
        form.Controls.Add(new Label { Text = "Hello partner", AutoSize = true, Location = new Point(20, 80), Font = new Font("Arial", 24) });
        form.Show();
        Application.DoEvents();
        var target = new WindowTarget(form.Handle, (uint)Environment.ProcessId, form.Text);
        // PrintWindow sends messages to the UI thread; keep that thread pumping.
        var capture = Task.Run(() => WindowCapture.Capture(target));
        var deadline = Stopwatch.StartNew();
        while (!capture.IsCompleted && deadline.Elapsed < TimeSpan.FromSeconds(5))
        {
            Application.DoEvents();
            Thread.Sleep(10);
        }
        if (!capture.IsCompleted) throw new TimeoutException("Synthetic window capture timed out.");
        using var bitmap = capture.GetAwaiter().GetResult();
        Check(bitmap.Size == form.ClientSize, "capture matches client-area dimensions");
        var pixels = Recognizer.Pixels(bitmap);
        Check(pixels.Where((_, index) => index % 4 != 3).Distinct().Count() > 2, "capture contains rendered content");
        Throws<InvalidOperationException>(() => WindowCapture.Capture(target, new Size(1, 1)), "layout changes rejected");
        form.Hide();
        Throws<InvalidOperationException>(() => WindowCapture.Capture(target), "unavailable window is not blank");
        Throws<InvalidOperationException>(() => WindowCapture.Capture(target with { ProcessId = uint.MaxValue }), "never attach to reused window from another process");
    }
}
