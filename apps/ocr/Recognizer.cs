using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Tesseract;

namespace AACpipe.Ocr;

internal sealed record OcrWord(string Text, float Confidence, RectangleF Box);

internal sealed class Recognizer : IDisposable
{
    internal const float AcceptConfidence = 60;
    // Tolerates a blinking cursor or anti-aliasing noise on an otherwise empty chat area.
    internal const double BlankNoiseFraction = 0.005;
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
            if (MatchesBlank(pixels, blankAreas[index])) continue;
            var (cleanPixels, allMarks) = RemoveSymbols(pixels, blankAreas[index], crop.Width, crop.Height);
            var cursors = allMarks.Where(mark => IsCursor(mark, allMarks)).Select(mark => Rectangle.Inflate(mark, 2, 2)).ToList();
            var marks = allMarks.Where(mark => !cursors.Any(cursor => cursor.Contains(mark))).ToList();
            foreach (var cursor in cursors) Erase(cleanPixels, blankAreas[index], crop.Width, crop.Height, cursor);
            using var cleaned = Image(cleanPixels, crop.Width, crop.Height);
            var words = RecognizeWords(cleaned, PageSegMode.SparseText);
            words.AddRange(RecoverMissed(cleaned, words, marks));
            var text = Compose(words, marks);
            if (text.Length == 0)
            {
                if (DifferenceFraction(pixels, blankAreas[index]) <= BlankNoiseFraction) continue;
                // Changed pixels but no readable words: symbols only, or text OCR could not read. Never clear on that basis.
                throw new InvalidOperationException("No readable text in the chat area (symbols only, or unreadable text). Last shared text is unchanged.");
            }
            parts.Add(text);
        }
        return string.Join(" ", parts);
    }

    // A text cursor is a thin upright stroke after the last mark of the bottom text row. Ignoring it stops a blinking
    // cursor being read as "I". Limitation: a lone "I" at the very end of the message is not shared until more is typed.
    internal static bool IsCursor(Rectangle mark, IReadOnlyList<Rectangle> marks) =>
        mark.Height >= 6 && mark.Width <= Math.Max(3, mark.Height / 5) &&
        !marks.Any(other => other != mark && (other.Top >= mark.Bottom - 2 ||
            (other.Left >= mark.Right && other.Top < mark.Bottom && mark.Top < other.Bottom)));

    // Sparse text detection can skip short isolated labels such as "I"; re-read uncovered letter marks on their own.
    private List<OcrWord> RecoverMissed(Bitmap cleaned, List<OcrWord> words, List<Rectangle> marks)
    {
        var covered = words.Where(word => word.Confidence >= AcceptConfidence).Select(word => RectangleF.Inflate(word.Box, 3, 3)).ToList();
        var groups = new List<Rectangle>();
        foreach (var mark in marks.Where(mark => mark.Height >= 6 && !covered.Any(box => box.IntersectsWith(mark))).OrderBy(mark => mark.Left))
        {
            var index = groups.FindIndex(group => mark.Top < group.Bottom && group.Top < mark.Bottom &&
                mark.Left - group.Right <= Math.Max(group.Height, mark.Height));
            if (index >= 0) groups[index] = Rectangle.Union(groups[index], mark);
            else groups.Add(mark);
        }
        var recovered = new List<OcrWord>();
        foreach (var group in groups.Take(24))
        {
            // Neighbouring words give the recogniser language context (for example "I" rather than "l").
            var pad = Math.Max(8, group.Height);
            var region = Rectangle.Intersect(Rectangle.Inflate(group, pad * 8, pad / 2), new Rectangle(Point.Empty, cleaned.Size));
            using var piece = cleaned.Clone(region, PixelFormat.Format32bppArgb);
            recovered.AddRange(RecognizeWords(piece, PageSegMode.SingleLine)
                .Select(word => word with { Box = new RectangleF(word.Box.X + region.X, word.Box.Y + region.Y, word.Box.Width, word.Box.Height) })
                .Where(word => RectangleF.Inflate(word.Box, 1, 1).IntersectsWith(group))
                .Select(word => english && word.Text is "I" or "l" && marks.Count(mark => word.Box.IntersectsWith(mark)) == 1
                    // A lone upright stroke: in sans-serif fonts I and l are identical, and only "I" is an English word.
                    ? word with { Text = "I", Confidence = Math.Max(word.Confidence, AcceptConfidence) }
                    : word));
        }
        return recovered;
    }

    private List<OcrWord> RecognizeWords(Bitmap crop, PageSegMode mode)
    {
        // Small AAC labels recognise more reliably when enlarged.
        var scale = crop.Width * crop.Height <= 1_000_000 ? 2 : 1;
        using var scaled = new Bitmap(crop.Width * scale, crop.Height * scale, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(scaled))
        {
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.DrawImage(crop, 0, 0, scaled.Width, scaled.Height);
        }
        using var memory = new MemoryStream();
        scaled.Save(memory, System.Drawing.Imaging.ImageFormat.Png);
        using var pix = Pix.LoadFromMemory(memory.ToArray());
        // Sparse text finds labels scattered between symbols without assuming a single text block.
        using var page = engine.Process(pix, mode);
        var words = new List<OcrWord>();
        using var iterator = page.GetIterator();
        iterator.Begin();
        do
        {
            var text = iterator.GetText(PageIteratorLevel.Word)?.Trim();
            if (string.IsNullOrEmpty(text) || !iterator.TryGetBoundingBox(PageIteratorLevel.Word, out var box)) continue;
            words.Add(new OcrWord(text, iterator.GetConfidence(PageIteratorLevel.Word),
                new RectangleF((float)box.X1 / scale, (float)box.Y1 / scale, (float)box.Width / scale, (float)box.Height / scale)));
        } while (iterator.Next(PageIteratorLevel.Word));
        return words;
    }

    // Keeps text-sized, confidently recognised words and orders them into reading order. Symbol artwork tends to
    // produce low-confidence, punctuation-only or wrongly sized fragments, which are ignored.
    internal static string Compose(IReadOnlyList<OcrWord> words, IReadOnlyList<Rectangle>? marks = null)
    {
        static bool HasAlphanumeric(OcrWord word) => word.Text.Any(char.IsLetterOrDigit);
        var confident = words.Where(word => word.Confidence >= AcceptConfidence && HasAlphanumeric(word)).ToList();
        if (confident.Count == 0)
        {
            if (words.Any(word => word.Confidence >= 30 && word.Text.Count(char.IsLetter) >= 3))
                throw new InvalidOperationException("Text could not be read reliably. Last shared text is unchanged.");
            return "";
        }
        var heights = confident.Select(word => word.Box.Height).Order().ToList();
        // Lower median: when sizes tie, labels are smaller than symbol artwork misread as letters.
        var textHeight = heights[(heights.Count - 1) / 2];
        bool TextSized(OcrWord word) => word.Box.Height >= 0.4f * textHeight && word.Box.Height <= 1.8f * textHeight;
        static float Middle(OcrWord word) => word.Box.Top + word.Box.Height / 2;

        var lines = new List<List<OcrWord>>();
        foreach (var word in confident.Where(TextSized).OrderBy(Middle))
        {
            var line = lines.LastOrDefault();
            if (line is not null && Math.Abs(Middle(word) - line.Average(Middle)) <= 0.5f * textHeight) line.Add(word);
            else lines.Add([word]);
        }
        // An unreadable word sitting in a text line would silently vanish from the message; refuse instead.
        if (words.Any(word => word.Confidence < AcceptConfidence && HasAlphanumeric(word) && TextSized(word) &&
            lines.Any(line => Math.Abs(Middle(word) - line.Average(Middle)) <= 0.35f * textHeight &&
                line.Any(other => Math.Abs(other.Box.Height - word.Box.Height) <= 0.5f * textHeight))))
            throw new InvalidOperationException("Part of the text could not be read reliably. Last shared text is unchanged.");
        // A letter-sized mark on a text line that OCR did not turn into a word (for example a lone "I") must not vanish.
        var accepted = lines.SelectMany(line => line).Select(word => RectangleF.Inflate(word.Box, 3, 3)).ToList();
        if ((marks ?? []).Any(mark => mark.Height >= 0.5f * textHeight && mark.Height <= 1.8f * textHeight &&
            lines.Any(line => Math.Abs(mark.Top + mark.Height / 2f - line.Average(Middle)) <= 0.5f * textHeight) &&
            !accepted.Any(box => box.IntersectsWith(mark))))
            throw new InvalidOperationException("Some text was not recognised. Last shared text is unchanged.");
        return string.Join(" ", lines.Select(line => string.Join(" ", line.OrderBy(word => word.Box.Left).Select(word => word.Text))));
    }

    // Paints symbol artwork back to the empty background so OCR only sees text. Shapes are groups of connected pixels
    // that differ from the empty reference; anything much taller than the typical letter is treated as a symbol.
    internal static (byte[] Pixels, List<Rectangle> Marks) RemoveSymbols(byte[] pixels, byte[] blank, int width, int height)
    {
        var count = width * height;
        if (pixels.Length != count * 4 || blank.Length != pixels.Length) return (pixels, []);
        var foreground = new bool[count];
        for (var i = 0; i < count; i++)
        {
            var o = i * 4;
            foreground[i] = Math.Abs(pixels[o] - blank[o]) > 48 || Math.Abs(pixels[o + 1] - blank[o + 1]) > 48 ||
                Math.Abs(pixels[o + 2] - blank[o + 2]) > 48;
        }
        var labels = new int[count];
        var boxes = new List<Rectangle> { Rectangle.Empty };
        var stack = new Stack<int>();
        for (var start = 0; start < count; start++)
        {
            if (!foreground[start] || labels[start] != 0) continue;
            var label = boxes.Count;
            int left = width, top = height, right = -1, bottom = -1;
            labels[start] = label;
            stack.Push(start);
            while (stack.Count > 0)
            {
                var i = stack.Pop();
                int x = i % width, y = i / width;
                left = Math.Min(left, x); right = Math.Max(right, x); top = Math.Min(top, y); bottom = Math.Max(bottom, y);
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
            boxes.Add(Rectangle.FromLTRB(left, top, right + 1, bottom + 1));
        }
        // Parts drawn inside a larger shape (eyes in a face, details in a picture) say nothing about letter size.
        var outer = boxes.Skip(1).Where(box => box.Height >= 4 &&
            !boxes.Skip(1).Any(other => other != box && other.Contains(box) && other.Width * other.Height > box.Width * box.Height)).ToList();
        if (outer.Count == 0) return (pixels, []);
        var heights = outer.Select(box => box.Height).Order().ToList();
        // Lower median: letters normally outnumber symbols, and symbols are larger than their labels.
        var letterHeight = heights[(heights.Count - 1) / 2];
        var symbol = boxes.Select(box => box.Height > 2.2 * letterHeight).ToArray();
        var marks = outer.Where(box => box.Height <= 2.2 * letterHeight).ToList();
        if (!symbol.Any(value => value)) return (pixels, marks);
        var cleaned = pixels.ToArray();
        const int margin = 2; // also removes the faint anti-aliased edge of each symbol
        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
            {
                var label = labels[y * width + x];
                if (label == 0 || !symbol[label]) continue;
                for (var my = Math.Max(0, y - margin); my <= Math.Min(height - 1, y + margin); my++)
                    for (var mx = Math.Max(0, x - margin); mx <= Math.Min(width - 1, x + margin); mx++)
                    {
                        var o = (my * width + mx) * 4;
                        Array.Copy(blank, o, cleaned, o, 4);
                    }
            }
        return (cleaned, marks);
    }

    private static void Erase(byte[] pixels, byte[] blank, int width, int height, Rectangle area)
    {
        area.Intersect(new Rectangle(0, 0, width, height));
        for (var y = area.Top; y < area.Bottom; y++)
            Array.Copy(blank, (y * width + area.Left) * 4, pixels, (y * width + area.Left) * 4, area.Width * 4);
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
