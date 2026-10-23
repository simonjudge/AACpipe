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
        // Match the app (PerMonitorV2) so window and screen coordinates are both physical pixels.
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        try
        {
            TestTracker();
            TestBridgeParsing();
            TestBridgeTransport().GetAwaiter().GetResult();
            var modelPath = args.Length > 0 ? Path.GetFullPath(args[0]) : throw new ArgumentException("Pass the tessdata directory.");
            TestLayout();
            TestRecognition(modelPath);
            TestWindowCapture();
            Console.WriteLine($"PASS: {passed} assertions (tracking, bridge, text layout, actual OCR with symbols, capture).");
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

    private static void TestLayout()
    {
        // "Hi you": letters 16 px tall; letter gaps 2 px, word gap 8 px. A 60 px picture sits above.
        Rectangle[] letters = [new(10, 100, 10, 16), new(22, 100, 4, 16), new(34, 104, 9, 12), new(45, 104, 9, 12), new(56, 104, 9, 12)];
        var picture = new Rectangle(10, 20, 60, 60);
        var (lines, letterHeight) = Recognizer.TextLines([.. letters, picture]);
        Check(lines.Count == 1 && lines[0].Top == 100 && lines[0].Bottom == 116, "one text line is found below the picture");
        Check(letterHeight is >= 12 and <= 16, $"letter height comes from the letters (actual: {letterHeight})");
        var words = Recognizer.SegmentWords(lines, letters, letterHeight);
        Check(words.Count == 1 && words[0].Count == 2 && words[0][0].Right == 26 && words[0][1].Left == 34, "letters are grouped into words by gap");
        Check(Recognizer.TextLines([new Rectangle(10, 10, 3, 16)]).Lines.Count == 0, "a single shape is not a text line");

        Rectangle[] twoRows = [new(10, 10, 9, 12), new(21, 10, 9, 12), new(10, 60, 9, 12), new(21, 60, 9, 12)];
        var (rows, rowHeight) = Recognizer.TextLines(twoRows);
        Check(rows.Count == 2, "two text rows are separate lines");
        var rowWords = Recognizer.SegmentWords(rows, twoRows, rowHeight);
        Check(rowWords.Count == 2 && rowWords[0][0].Top == 10 && rowWords[1][0].Top == 60, "lines are ordered top to bottom");

        Check(Recognizer.IsStroke(new Rectangle(0, 0, 3, 16), 12), "a plain upright stroke is a lone I");
        Check(!Recognizer.IsStroke(new Rectangle(0, 0, 9, 16), 12), "a wide letter is not a stroke");
        Check(!Recognizer.IsStroke(new Rectangle(0, 0, 2, 5), 12), "a short tick is not a stroke");

        // A detached symbol fragment near, but not on, the text line is erased; letters on the line are kept.
        using var image = new Bitmap(120, 140);
        using (var graphics = Graphics.FromImage(image))
        {
            graphics.Clear(Color.White);
            using var stroke = new Pen(Color.Black, 2) { Alignment = System.Drawing.Drawing2D.PenAlignment.Inset };
            foreach (var letter in letters) graphics.DrawRectangle(stroke, letter);
            graphics.FillEllipse(Brushes.SteelBlue, 10, 20, 60, 60);
            graphics.FillRectangle(Brushes.Black, 80, 40, 6, 6);
        }
        using var blank = new Bitmap(120, 140);
        using (var graphics = Graphics.FromImage(blank)) graphics.Clear(Color.White);
        var (cleaned, layout) = Recognizer.Analyse(Recognizer.Pixels(image), Recognizer.Pixels(blank), 120, 140);
        Check(layout.Marks.Count == letters.Length, $"only letters remain as marks (actual: {layout.Marks.Count})");
        static bool White(byte[] pixels, int x, int y) => pixels[(y * 120 + x) * 4] > 200 && pixels[(y * 120 + x) * 4 + 1] > 200;
        Check(White(cleaned, 40, 50) && White(cleaned, 82, 42), "the picture and its detached fragment are erased");
        Check(!White(cleaned, 10, 108), "letters are kept");
        Check(Recognizer.Background(Recognizer.Pixels(blank)).ToArgb() == Color.White.ToArgb(), "background is the blank's main colour");
    }
    // Original geometric pictures, not third-party symbol artwork.
    private static void DrawSymbol(Graphics graphics, int kind, int x, int y)
    {
        using var pen = new Pen(Color.Black, 4);
        switch (kind % 6)
        {
            case 0: graphics.FillEllipse(Brushes.Gold, x, y, 64, 64); graphics.DrawEllipse(pen, x, y, 64, 64); break;
            case 1: graphics.FillRectangle(Brushes.SteelBlue, x + 4, y + 4, 56, 56); break;
            case 2: graphics.FillPolygon(Brushes.Green, new Point[] {new Point(x + 32, y), new Point(x + 64, y + 64), new Point(x, y + 64) }); break;
            case 3:
                graphics.DrawEllipse(pen, x + 22, y, 20, 20);
                graphics.DrawLine(pen, x + 32, y + 20, x + 32, y + 46);
                graphics.DrawLine(pen, x + 10, y + 30, x + 54, y + 30);
                graphics.DrawLine(pen, x + 32, y + 46, x + 14, y + 64);
                graphics.DrawLine(pen, x + 32, y + 46, x + 50, y + 64);
                break;
            case 4:
                graphics.FillPolygon(Brushes.IndianRed, new Point[] {new Point(x + 32, y), new Point(x + 64, y + 28), new Point(x, y + 28) });
                graphics.FillRectangle(Brushes.Peru, x + 8, y + 28, 48, 36);
                graphics.FillRectangle(Brushes.White, x + 26, y + 42, 12, 22);
                break;
            default:
                graphics.DrawArc(pen, x + 4, y + 4, 56, 56, 200, 300);
                graphics.DrawLine(pen, x + 32, y + 10, x + 32, y + 54);
                break;
        }
    }

    private static Bitmap ChatBar(Size size, IReadOnlyList<string[]> lines)
    {
        var image = new Bitmap(size.Width, size.Height);
        using var graphics = Graphics.FromImage(image);
        graphics.Clear(Color.White);
        graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        using var font = new Font("Arial", 22, FontStyle.Regular, GraphicsUnit.Pixel);
        var kind = 0;
        for (var row = 0; row < lines.Count; row++)
        {
            var x = 30;
            foreach (var word in lines[row])
            {
                var width = Math.Max(72, (int)graphics.MeasureString(word, font).Width + 8);
                var top = 20 + row * 125;
                DrawSymbol(graphics, kind++, x + (width - 64) / 2, top);
                var label = (int)graphics.MeasureString(word, font).Width;
                graphics.DrawString(word, font, Brushes.Black, x + (width - label) / 2, top + 72);
                x += width + 14;
            }
        }
        return image;
    }

    private static void TestRecognition(string modelPath)
    {
        var size = new Size(1000, 300);
        using var empty = ChatBar(size, []);
        // The user drags one rectangle around the whole chat area, symbols and all lines included.
        var area = new[] { new Rectangle(10, 5, 980, 285) };
        var blanks = Recognizer.Calibrate(empty, area);
        using var recognizer = new Recognizer(modelPath, "eng");
        Check(recognizer.Read(empty, area, blanks) == "", "calibrated blank is empty");

        using var frame = ChatBar(size, [["Hello", "partner", "I", "want"], ["a", "drink", "please"]]);
        var timer = Stopwatch.StartNew();
        var recognised = recognizer.Read(frame, area, blanks);
        Console.WriteLine($"  chat bar read as: \"{recognised}\" in {timer.ElapsedMilliseconds} ms");
        Check(recognised == "Hello partner I want a drink please", $"symbols are ignored and both lines read in order (actual: {recognised})");

        using (var graphics = Graphics.FromImage(frame)) graphics.FillRectangle(Brushes.Black, 282, 222, 2, 26);
        var withCursor = recognizer.Read(frame, area, blanks);
        Check(withCursor == "Hello partner I want a drink please", $"a text cursor after the last word is not read as I (actual: {withCursor})");
        Check(Recognizer.IsCursor(new Rectangle(270, 213, 2, 26), [new Rectangle(201, 216, 61, 20), new Rectangle(270, 213, 2, 26)]), "trailing thin stroke is a cursor");
        Check(!Recognizer.IsCursor(new Rectangle(242, 91, 2, 16), [new Rectangle(242, 91, 2, 16), new Rectangle(305, 91, 44, 16)]), "a lone I followed by more text is not a cursor");
        Check(!Recognizer.IsCursor(new Rectangle(242, 91, 2, 16), [new Rectangle(242, 91, 2, 16), new Rectangle(51, 220, 10, 12)]), "a lone I above another text row is not a cursor");

        using var single = ChatBar(size, [["Hello"]]);
        Check(recognizer.Read(single, area, blanks) == "Hello", "a single symbol word");

        using var symbolsOnly = (Bitmap)empty.Clone();
        using (var graphics = Graphics.FromImage(symbolsOnly))
            for (var kind = 0; kind < 6; kind++) DrawSymbol(graphics, kind, 30 + kind * 90, 20);
        try { Console.WriteLine("  symbols-only read as: \"" + recognizer.Read(symbolsOnly, area, blanks) + "\""); } catch (InvalidOperationException) { }
        Throws<InvalidOperationException>(() => recognizer.Read(symbolsOnly, area, blanks), "symbols without readable text never clear the partner display");

        using var cursor = (Bitmap)empty.Clone();
        using (var graphics = Graphics.FromImage(cursor)) graphics.FillRectangle(Brushes.Black, 30, 100, 2, 26);
        Check(recognizer.Read(cursor, area, blanks) == "", "a blinking text cursor alone is blank");

        using var failed = new Bitmap(size.Width, size.Height);
        using (var graphics = Graphics.FromImage(failed)) graphics.Clear(Color.Black);
        Throws<InvalidOperationException>(() => recognizer.Read(failed, area, blanks), "black failed capture is not clear");
        var changed = blanks[0].ToArray();
        changed[100] = 0;
        Check(!Recognizer.MatchesBlank(changed, blanks[0]), "a small mark prevents blank classification");
        Check(Recognizer.DifferenceFraction(blanks[0], blanks[0]) == 0, "identical images have no difference");
        Throws<InvalidOperationException>(() => recognizer.Read(frame, [], []), "missing calibration is an error");
    }

    private static T Pump<T>(Func<T> work)
    {
        // Capture sends messages to this UI thread; keep it pumping.
        var task = Task.Run(work);
        var deadline = Stopwatch.StartNew();
        while (!task.IsCompleted && deadline.Elapsed < TimeSpan.FromSeconds(5))
        {
            Application.DoEvents();
            Thread.Sleep(10);
        }
        if (!task.IsCompleted) throw new TimeoutException("Synthetic window capture timed out.");
        return task.GetAwaiter().GetResult();
    }

    private static void TestWindowCapture()
    {
        using var form = new Form
        {
            Text = "AACpipe OCR synthetic capture test", ClientSize = new Size(500, 200), ShowInTaskbar = false,
            StartPosition = FormStartPosition.Manual, Location = new Point(100, 100), TopMost = true, BackColor = Color.White,
        };
        form.Controls.Add(new Label { Text = "Hello partner", AutoSize = true, Location = new Point(20, 80), Font = new Font("Arial", 24) });
        form.Show();
        form.Activate();
        for (var i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
        var target = new WindowTarget(form.Handle, (uint)Environment.ProcessId, form.Text);
        var area = new[] { new Rectangle(10, 60, 480, 80) };

        var (setup, mode) = Pump(() => WindowCapture.CaptureForSetup(target));
        using (setup)
        {
            Check(mode == CaptureMode.Window, "applications that support window capture use it");
            Check(setup.Size == form.ClientSize, "capture matches client-area dimensions");
            Check(!WindowCapture.IsUniform(setup), "capture contains rendered content");
        }
        using (var screen = Pump(() => WindowCapture.Capture(target, CaptureMode.Screen, form.ClientSize, area)).Frame)
        {
            Check(screen.Size == form.ClientSize, "screen fallback matches client-area dimensions");
            Check(!WindowCapture.IsUniform(screen), "screen fallback contains rendered content");
        }
        using (var cover = new Form
        {
            Text = "cover", ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, TopMost = true,
            FormBorderStyle = FormBorderStyle.None, Location = form.PointToScreen(new Point(150, 70)), Size = new Size(120, 50),
        })
        {
            cover.Show();
            for (var i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
            Throws<InvalidOperationException>(() => Pump(() => WindowCapture.Capture(target, CaptureMode.Screen, form.ClientSize, area)),
                "a covered chat area is refused in screen mode");
            Check(Pump(() => WindowCapture.Capture(target, CaptureMode.Screen, form.ClientSize, [new Rectangle(10, 150, 480, 40)])).Frame is { } uncovered && uncovered.Size == form.ClientSize,
                "uncovered regions are still captured");
        }
        using var plain = new Bitmap(4, 4);
        using (var graphics = Graphics.FromImage(plain)) graphics.Clear(Color.Black);
        Check(WindowCapture.IsUniform(plain), "uniform failed captures are detected");
        Throws<InvalidOperationException>(() => WindowCapture.Capture(target, CaptureMode.Window, new Size(1, 1), area), "layout changes rejected");
        form.Hide();
        Throws<InvalidOperationException>(() => WindowCapture.Capture(target, CaptureMode.Screen, form.ClientSize, area), "unavailable window is not blank");
        Throws<InvalidOperationException>(() => WindowCapture.Capture(target with { ProcessId = uint.MaxValue }, CaptureMode.Window, form.ClientSize, area),
            "never attach to reused window from another process");
    }
}