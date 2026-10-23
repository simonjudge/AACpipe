using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Tesseract;

namespace AACpipe.Ocr;

internal sealed class Recognizer : IDisposable
{
    private readonly TesseractEngine engine;

    internal Recognizer(string dataPath, string language)
    {
        engine = new TesseractEngine(dataPath, language, EngineMode.LstmOnly);
        engine.SetVariable("user_defined_dpi", "150");
        engine.SetVariable("debug_file", "NUL");
    }

    internal string Read(Bitmap frame, IReadOnlyList<Rectangle> bands, IReadOnlyList<byte[]> blankBands)
    {
        if (bands.Count == 0 || bands.Count != blankBands.Count)
            throw new InvalidOperationException("Select and calibrate the text bands before sharing.");
        var lines = new List<string>();
        for (var index = 0; index < bands.Count; index++)
        {
            var band = bands[index];
            if (!new Rectangle(Point.Empty, frame.Size).Contains(band) || band.Width < 8 || band.Height < 8)
                throw new InvalidOperationException("A text band is outside the capture. Recalibrate.");
            using var crop = frame.Clone(band, PixelFormat.Format32bppArgb);
            if (MatchesBlank(Pixels(crop), blankBands[index])) continue;
            using var memory = new MemoryStream();
            crop.Save(memory, System.Drawing.Imaging.ImageFormat.Png);
            using var pix = Pix.LoadFromMemory(memory.ToArray());
            using var page = engine.Process(pix, PageSegMode.SingleLine);
            var text = TextTracker.Normalize(page.GetText());
            if (text.Length == 0 || page.GetMeanConfidence() < 0.65f)
                throw new InvalidOperationException("Text could not be read reliably. Last shared text is unchanged; check the text bands.");
            lines.Add(text);
        }
        return string.Join(" ", lines);
    }

    internal static List<byte[]> Calibrate(Bitmap frame, IReadOnlyList<Rectangle> bands)
    {
        if (bands.Count == 0) throw new InvalidOperationException("Select at least one text band.");
        return bands.Select(band =>
        {
            using var crop = frame.Clone(band, PixelFormat.Format32bppArgb);
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
        // Deliberately conservative: even a small glyph must prevent a blank classification.
        for (var i = 0; i < current.Length; i++)
            if (i % 4 != 3 && Math.Abs(current[i] - blank[i]) > 8) return false;
        return true;
    }

    public void Dispose() => engine.Dispose();
}
