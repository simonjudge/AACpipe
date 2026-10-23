using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Tesseract;

namespace AACpipe.Ocr;

internal sealed record OcrWord(string Text, float Confidence, RectangleF Box);

// Letter-sized shapes on text lines, with the typical letter height. Everything else in the chat area is symbol artwork.
internal sealed record TextLayout(List<Rectangle> Lines, List<Rectangle> Marks, int LetterHeight);

internal sealed class Recognizer : IDisposable
{
    internal const float AcceptConfidence = 60;
    // Tolerates a blinking cursor or anti-aliasing noise on an otherwise empty chat area.
    internal const double BlankNoiseFraction = 0.005;
    // Gaps between letters are at most about a quarter of the letter height; gaps between words are about half or more.
    internal const double WordGap = 0.33;
    // Test/diagnostic hook: receives each rebuilt text line and its raw OCR words.
    internal static Action<Bitmap, IReadOnlyList<OcrWord>>? Diagnostics;
    private readonly TesseractEngine engine;
    private readonly bool english;

    internal Recognizer(string dataPath, string language)
    {
        engine = new TesseractEngine(dataPath, language, EngineMode.LstmOnly);
        english = language.Split('+').Contains("eng");
        engine.SetVariable("debug_file", "NUL");
        // A lone capital I is otherwise often read as a vertical bar, which AAC messages practically never contain.
        engine.SetVariable("tessedit_char_blacklist", "|");
    }

    internal string Read(Bitmap frame, IReadOnlyList<Rectangle> areas, IReadOnlyList<byte[]> blankAreas)
    {
        if (areas.Count == 0 || areas.Count != blankAreas.Count)
            throw new InvalidOperationException("Select and calibrate the chat area before sharing.");
        var parts = new List<string>();
        for (var index = 0; index < areas.Count; index++)
        {
            var area = areas[index];
            if (!new Rectangle(Point.Empty, frame.Size).Contains(area) || area.Width < 8 || area.Height < 8)
                throw new InvalidOperationException("The chat area is outside the capture. Recalibrate.");
            using var crop = frame.Clone(area, PixelFormat.Format32bppArgb);
            var pixels = Pixels(crop);
            var blank = blankAreas[index];
            if (MatchesBlank(pixels, blank)) continue;
            var (cleanPixels, layout) = Analyse(pixels, blank, crop.Width, crop.Height);
            var background = Background(blank);
            var cursors = layout.Marks.Where(mark => IsCursor(mark, layout.Marks)).ToList();
            foreach (var cursor in cursors) Fill(cleanPixels, crop.Width, crop.Height, Rectangle.Inflate(cursor, 2, 2), background);
            var lines = SegmentWords(layout.Lines, layout.Marks.Except(cursors).ToList(), layout.LetterHeight);
            using var cleaned = Image(cleanPixels, crop.Width, crop.Height);
            var text = string.Join(" ", lines.Select(words => ReadLine(cleaned, words, layout, background)));
            if (text.Length == 0)
            {
                if (DifferenceFraction(pixels, blank) <= BlankNoiseFraction) continue;
                // Changed pixels but no text lines: symbols only, or text that could not be found. Never clear on that basis.
                throw new InvalidOperationException("No readable text in the chat area (symbols only, or unreadable text). Last shared text is unchanged.");
            }
            parts.Add(text);
        }
        return string.Join(" ", parts);
    }

    // Rebuilds one text line with wide, even gaps between the words found from the pixels, reads it in one pass, and
    // requires a confident reading for every word, so no word can silently disappear.
    private string ReadLine(Bitmap cleaned, List<Rectangle> words, TextLayout layout, Color background)
    {
        var letter = layout.LetterHeight;
        var pad = Math.Max(2, letter * 3 / 10);
        var gap = Math.Max(8, letter * 3 / 2);
        var bounds = new Rectangle(Point.Empty, cleaned.Size);
        var crops = words.Select(word => Rectangle.Intersect(Rectangle.Inflate(word, pad, pad), bounds)).ToList();
        var top = crops.Min(crop => crop.Top);
        var stripHeight = crops.Max(crop => crop.Bottom) - top + 2 * gap;
        var stripWidth = crops.Sum(crop => crop.Width) + gap * (crops.Count + 1);
        // Tesseract reads best with letters roughly 30-40 pixels tall.
        var scale = Math.Clamp(36.0 / letter, 1.0, 4.0);
        using var strip = new Bitmap((int)Math.Ceiling(stripWidth * scale), (int)Math.Ceiling(stripHeight * scale), PixelFormat.Format32bppArgb);
        var slots = new List<(double Left, double Right)>();
        using (var graphics = Graphics.FromImage(strip))
        {
            graphics.Clear(background);
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            var x = gap;
            foreach (var crop in crops)
            {
                var target = new RectangleF((float)(x * scale), (float)((gap + crop.Top - top) * scale), (float)(crop.Width * scale), (float)(crop.Height * scale));
                graphics.DrawImage(cleaned, target, crop, GraphicsUnit.Pixel);
                slots.Add(((x - gap / 2.0) * scale, (x + crop.Width + gap / 2.0) * scale));
                x += crop.Width + gap;
            }
        }
        var found = Recognize(strip);
        Diagnostics?.Invoke(strip, found);
        var result = new List<string>();
        for (var slot = 0; slot < slots.Count; slot++)
        {
            var pieces = found.Where(word => word.Box.Left + word.Box.Width / 2 >= slots[slot].Left &&
                word.Box.Left + word.Box.Width / 2 < slots[slot].Right).OrderBy(word => word.Box.Left).ToList();
            var text = string.Concat(pieces.Select(piece => piece.Text));
            var confidence = pieces.Count == 0 ? 0 : pieces.Min(piece => piece.Confidence);
            var shapes = layout.Marks.Where(mark => words[slot].Contains(mark)).ToList();
            // A word that is one plain upright stroke: Tesseract guesses I, l, 1, ! or | for it, but in sans-serif
            // fonts only "I" is an English word of that shape.
            if (english && shapes.Count == 1 && IsStroke(shapes[0], letter))
                (text, confidence) = ("I", Math.Max(confidence, AcceptConfidence));
            if (text.Length == 0 || confidence < AcceptConfidence)
                throw new InvalidOperationException("Part of the text could not be read reliably. Last shared text is unchanged.");
            result.Add(text);
        }
        return string.Join(" ", result);
    }

    internal static bool IsStroke(Rectangle mark, int letterHeight) =>
        mark.Width <= Math.Max(3, mark.Height / 4) && mark.Height >= letterHeight * 0.8 && mark.Height <= letterHeight * 2;

    // Returns individual characters, so that the word slots decide word boundaries rather than Tesseract's spacing.
    private List<OcrWord> Recognize(Bitmap image)
    {
        using var memory = new MemoryStream();
        image.Save(memory, System.Drawing.Imaging.ImageFormat.Png);
        using var pix = Pix.LoadFromMemory(memory.ToArray());
        using var page = engine.Process(pix, PageSegMode.SingleLine);
        var characters = new List<OcrWord>();
        using var iterator = page.GetIterator();
        iterator.Begin();
        do
        {
            var text = iterator.GetText(PageIteratorLevel.Symbol)?.Trim();
            if (string.IsNullOrEmpty(text) || !iterator.TryGetBoundingBox(PageIteratorLevel.Symbol, out var box)) continue;
            characters.Add(new OcrWord(text, iterator.GetConfidence(PageIteratorLevel.Symbol), new RectangleF(box.X1, box.Y1, box.Width, box.Height)));
        } while (iterator.Next(PageIteratorLevel.Symbol));
        return characters;
    }

    // A text cursor is a thin upright stroke after the last mark of the bottom text row. Ignoring it stops a blinking
    // cursor being read as "I". Limitation: a lone "I" at the very end of the message is not shared until more is typed.
    internal static bool IsCursor(Rectangle mark, IReadOnlyList<Rectangle> marks) =>
        mark.Height >= 6 && mark.Width <= Math.Max(3, mark.Height / 5) &&
        !marks.Any(other => other != mark && (other.Top >= mark.Bottom - 2 ||
            (other.Left >= mark.Right && other.Top < mark.Bottom && mark.Top < other.Bottom)));

    // Groups each line's letter shapes into words by the horizontal gaps between them. Each shape belongs to the line
    // it overlaps most. Returns lines top to bottom, words left to right; word boxes span the full line height.
    internal static List<List<Rectangle>> SegmentWords(IReadOnlyList<Rectangle> lines, IReadOnlyList<Rectangle> marks, int letterHeight)
    {
        var ordered = lines.OrderBy(line => line.Top).ToList();
        var members = ordered.Select(_ => new List<Rectangle>()).ToList();
        foreach (var mark in marks)
        {
            var best = -1;
            var bestOverlap = 0;
            for (var i = 0; i < ordered.Count; i++)
            {
                var overlap = Math.Min(mark.Bottom, ordered[i].Bottom) - Math.Max(mark.Top, ordered[i].Top);
                if (overlap > bestOverlap) (best, bestOverlap) = (i, overlap);
            }
            if (best >= 0) members[best].Add(mark);
        }
        var result = new List<List<Rectangle>>();
        for (var i = 0; i < ordered.Count; i++)
        {
            var words = new List<Rectangle>();
            foreach (var mark in members[i].OrderBy(mark => mark.Left))
            {
                if (words.Count > 0 && mark.Left - words[^1].Right <= WordGap * letterHeight) words[^1] = Rectangle.Union(words[^1], mark);
                else words.Add(mark);
            }
            if (words.Count > 0)
                result.Add(words.Select(word => Rectangle.FromLTRB(word.Left, Math.Min(word.Top, ordered[i].Top), word.Right,
                    Math.Max(word.Bottom, ordered[i].Bottom))).ToList());
        }
        return result;
    }

    // Finds text lines: runs of similar-sized shapes whose vertical extents overlap and that sit close together, the
    // way letters in words do. Returns each line's vertical band and the typical letter height.
    internal static (List<Rectangle> Lines, int LetterHeight) TextLines(IReadOnlyList<Rectangle> shapes)
    {
        var candidates = shapes.Where(box => box.Height >= 4 && box.Width <= 4 * box.Height).ToList();
        var parent = Enumerable.Range(0, candidates.Count).ToArray();
        int Find(int i) => parent[i] == i ? i : parent[i] = Find(parent[i]);
        for (var a = 0; a < candidates.Count; a++)
            for (var b = a + 1; b < candidates.Count; b++)
            {
                Rectangle first = candidates[a], second = candidates[b];
                var ratio = (double)Math.Max(first.Height, second.Height) / Math.Min(first.Height, second.Height);
                var overlap = Math.Min(first.Bottom, second.Bottom) - Math.Max(first.Top, second.Top);
                var gap = Math.Max(first.Left, second.Left) - Math.Min(first.Right, second.Right);
                if (ratio <= 2 && overlap >= 0.5 * Math.Min(first.Height, second.Height) && gap <= 1.2 * Math.Max(first.Height, second.Height))
                    parent[Find(a)] = Find(b);
            }
        var runs = Enumerable.Range(0, candidates.Count).GroupBy(Find).Where(group => group.Count() >= 2)
            .Select(group => group.Select(i => candidates[i]).ToList()).ToList();
        if (runs.Count == 0) return ([], 0);
        // Lower median: letters normally outnumber picture parts, and pictures are larger than letters.
        var heights = runs.SelectMany(run => run).Select(box => box.Height).Order().ToList();
        var letterHeight = heights[(heights.Count - 1) / 2];
        var lines = new List<Rectangle>();
        foreach (var run in runs)
        {
            var runHeight = run.Select(box => box.Height).Order().ElementAt((run.Count - 1) / 2);
            if (runHeight < 0.6 * letterHeight || runHeight > 1.7 * letterHeight) continue;
            var band = run.Aggregate(Rectangle.Union);
            var index = lines.FindIndex(line => line.Top < band.Bottom && band.Top < line.Bottom);
            if (index >= 0) lines[index] = Rectangle.Union(lines[index], band);
            else lines.Add(band);
        }
        return (lines, letterHeight);
    }

    // Splits the changed pixels into connected shapes and paints everything that is not text on a text line (symbol
    // artwork, including small detached parts such as sparkles, speech bubbles or lips) with the background colour.
    internal static (byte[] Cleaned, TextLayout Layout) Analyse(byte[] pixels, byte[] blank, int width, int height)
    {
        var count = width * height;
        if (pixels.Length != count * 4 || blank.Length != pixels.Length) throw new InvalidOperationException("The chat area changed size. Recalibrate.");
        var background = Background(blank);
        var foreground = new bool[count];
        for (var i = 0; i < count; i++)
        {
            var o = i * 4;
            // Ink must differ from both the empty reference and the background; this ignores where an old cursor was.
            foreground[i] = Distance(pixels, o, blank[o], blank[o + 1], blank[o + 2]) > 48 &&
                Distance(pixels, o, background.B, background.G, background.R) > 48;
        }
        var labels = new int[count];
        var shapes = new List<Rectangle>();
        var solid = new List<bool>();
        var stack = new Stack<int>();
        for (var start = 0; start < count; start++)
        {
            if (!foreground[start] || labels[start] != 0) continue;
            if (shapes.Count >= 4000) throw new InvalidOperationException("The chat area is too busy to read (a photo or pattern?). Last shared text is unchanged.");
            var label = shapes.Count + 1;
            int left = width, top = height, right = -1, bottom = -1, area = 0, edge = 0;
            labels[start] = label;
            stack.Push(start);
            while (stack.Count > 0)
            {
                var i = stack.Pop();
                int x = i % width, y = i / width;
                left = Math.Min(left, x); right = Math.Max(right, x); top = Math.Min(top, y); bottom = Math.Max(bottom, y);
                area++;
                if (x == 0 || y == 0 || x == width - 1 || y == height - 1 || !foreground[i - 1] || !foreground[i + 1] ||
                    !foreground[i - width] || !foreground[i + width]) edge++;
                for (var dy = -1; dy <= 1; dy++)
                    for (var dx = -1; dx <= 1; dx++)
                    {
                        int nx = x + dx, ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        var n = ny * width + nx;
                        if (!foreground[n] || labels[n] != 0) continue;
                        labels[n] = label;
                        stack.Push(n);
                    }
            }
            shapes.Add(Rectangle.FromLTRB(left, top, right + 1, bottom + 1));
            // Letters are drawn with thin strokes; filled pictures are much thicker for their height.
            solid.Add(2.0 * area / edge > Math.Max(4, 0.28 * (bottom - top + 1)));
        }
        // Parts drawn inside a larger shape (eyes in a face, pictures in a grid) are judged by the shape around them.
        static long Area(Rectangle box) => (long)box.Width * box.Height;
        var containers = shapes.Select(box => shapes.Where(other => Area(other) > Area(box) && other.Contains(box)).ToList()).ToList();
        var (lines, letterHeight) = TextLines(shapes.Where((_, i) => containers[i].Count == 0 && !solid[i]).ToList());
        bool OnLine(Rectangle box) => box.Height <= 2.2 * letterHeight && lines.Any(line =>
            box.Top >= line.Top - letterHeight / 2 && box.Bottom <= line.Bottom + letterHeight / 2);
        var keep = shapes.Select((box, i) => OnLine(box) && containers[i].All(OnLine)).ToArray();
        var marks = shapes.Where((box, i) => keep[i] && containers[i].Count == 0 && box.Height >= 4).ToList();
        var cleaned = pixels.ToArray();
        const int margin = 2; // also removes the faint anti-aliased edge around each symbol
        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
            {
                var label = labels[y * width + x];
                if (label == 0 || keep[label - 1]) continue;
                for (var my = Math.Max(0, y - margin); my <= Math.Min(height - 1, y + margin); my++)
                    for (var mx = Math.Max(0, x - margin); mx <= Math.Min(width - 1, x + margin); mx++)
                    {
                        var near = labels[my * width + mx];
                        if (near != 0 && keep[near - 1]) continue;
                        var o = (my * width + mx) * 4;
                        (cleaned[o], cleaned[o + 1], cleaned[o + 2], cleaned[o + 3]) = (background.B, background.G, background.R, 255);
                    }
            }
        return (cleaned, new TextLayout(lines, marks, letterHeight));
    }

    private static int Distance(byte[] pixels, int o, byte b, byte g, byte r) =>
        Math.Max(Math.Abs(pixels[o] - b), Math.Max(Math.Abs(pixels[o + 1] - g), Math.Abs(pixels[o + 2] - r)));

    // The most common colour of the empty chat area.
    internal static Color Background(byte[] blank)
    {
        var counts = new Dictionary<int, int>();
        for (var o = 0; o + 3 < blank.Length; o += 4 * 7)
        {
            var key = blank[o] << 16 | blank[o + 1] << 8 | blank[o + 2];
            counts[key] = counts.GetValueOrDefault(key) + 1;
        }
        if (counts.Count == 0) return Color.White;
        var best = counts.MaxBy(pair => pair.Value).Key;
        return Color.FromArgb(255, best & 0xFF, (best >> 8) & 0xFF, best >> 16);
    }

    private static void Fill(byte[] pixels, int width, int height, Rectangle area, Color colour)
    {
        area.Intersect(new Rectangle(0, 0, width, height));
        for (var y = area.Top; y < area.Bottom; y++)
            for (var x = area.Left; x < area.Right; x++)
            {
                var o = (y * width + x) * 4;
                (pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]) = (colour.B, colour.G, colour.R, 255);
            }
    }

    private static Bitmap Image(byte[] pixels, int width, int height)
    {
        var image = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        var data = image.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try
        {
            for (var y = 0; y < height; y++) Marshal.Copy(pixels, y * width * 4, data.Scan0 + y * data.Stride, width * 4);
        }
        finally { image.UnlockBits(data); }
        return image;
    }

    internal static List<byte[]> Calibrate(Bitmap frame, IReadOnlyList<Rectangle> areas)
    {
        if (areas.Count == 0) throw new InvalidOperationException("Select the chat area first.");
        return areas.Select(area =>
        {
            using var crop = frame.Clone(area, PixelFormat.Format32bppArgb);
            return Pixels(crop);
        }).ToList();
    }

    internal static byte[] Pixels(Bitmap image)
    {
        var data = image.LockBits(new Rectangle(Point.Empty, image.Size), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var pixels = new byte[image.Width * image.Height * 4];
            for (var y = 0; y < image.Height; y++)
                Marshal.Copy(data.Scan0 + y * data.Stride, pixels, y * image.Width * 4, image.Width * 4);
            return pixels;
        }
        finally { image.UnlockBits(data); }
    }

    internal static bool MatchesBlank(byte[] current, byte[] blank)
    {
        if (current.Length != blank.Length) return false;
        for (var i = 0; i < current.Length; i++)
            if (i % 4 != 3 && Math.Abs(current[i] - blank[i]) > 8) return false;
        return true;
    }

    internal static double DifferenceFraction(byte[] current, byte[] blank)
    {
        if (current.Length != blank.Length || current.Length == 0) return 1;
        var changed = 0;
        for (var i = 0; i < current.Length; i += 4)
            if (Math.Abs(current[i] - blank[i]) > 24 || Math.Abs(current[i + 1] - blank[i + 1]) > 24 ||
                Math.Abs(current[i + 2] - blank[i + 2]) > 24) changed++;
        return changed / (current.Length / 4.0);
    }

    public void Dispose() => engine.Dispose();
}
