using System.Drawing.Drawing2D;

namespace AACpipe.Ocr;

internal sealed class BandSelector : Control
{
    private Bitmap? image;
    private Point? anchor;
    private Point current;
    internal List<Rectangle> Bands { get; } = [];
    internal event Action? BandsChanged;

    internal BandSelector()
    {
        DoubleBuffered = true;
        BackColor = Color.FromArgb(35, 35, 35);
        Cursor = Cursors.Cross;
    }

    internal void SetImage(Bitmap? value)
    {
        image?.Dispose();
        image = value;
        Invalidate();
    }

    internal void SetBands(IEnumerable<Rectangle> bands)
    {
        Bands.Clear();
        Bands.AddRange(bands);
        Invalidate();
    }

    internal void ClearBands()
    {
        Bands.Clear();
        BandsChanged?.Invoke();
        Invalidate();
    }

    private RectangleF Destination()
    {
        if (image is null) return RectangleF.Empty;
        var scale = Math.Min((float)ClientSize.Width / image.Width, (float)ClientSize.Height / image.Height);
        return new RectangleF((ClientSize.Width - image.Width * scale) / 2,
            (ClientSize.Height - image.Height * scale) / 2, image.Width * scale, image.Height * scale);
    }

    private Point ImagePoint(Point point)
    {
        var destination = Destination();
        if (image is null || destination.Width == 0) return Point.Empty;
        return new Point(
            Math.Clamp((int)((point.X - destination.X) * image.Width / destination.Width), 0, image.Width),
            Math.Clamp((int)((point.Y - destination.Y) * image.Height / destination.Height), 0, image.Height));
    }

    private static Rectangle Between(Point a, Point b) =>
        Rectangle.FromLTRB(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Max(a.X, b.X), Math.Max(a.Y, b.Y));

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (!Enabled || image is null || e.Button != MouseButtons.Left || !Destination().Contains(e.Location)) return;
        anchor = ImagePoint(e.Location);
        current = anchor.Value;
        Capture = true;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (anchor is null) return;
        current = ImagePoint(e.Location);
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (anchor is null) return;
        var band = Between(anchor.Value, ImagePoint(e.Location));
        anchor = null;
        Capture = false;
        // One rectangle covers the whole chat area, so a new drag replaces the current (possibly guessed) one.
        if (band.Width >= 8 && band.Height >= 8)
        {
            Bands.Clear();
            Bands.Add(band);
            BandsChanged?.Invoke();
        }
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (image is null)
        {
            TextRenderer.DrawText(e.Graphics, "Choose the AAC window and click Capture. The chat area is found automatically; if it is wrong, drag one\nrectangle around the whole chat area. Include the symbols and every line of text; symbols are ignored.", Font,
                ClientRectangle, Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.WordBreak);
            return;
        }
        var destination = Destination();
        e.Graphics.DrawImage(image, destination);
        e.Graphics.SetClip(destination);
        e.Graphics.TranslateTransform(destination.X, destination.Y);
        e.Graphics.ScaleTransform(destination.Width / image.Width, destination.Height / image.Height);
        using var pen = new Pen(Color.Lime, 2 * image.Width / destination.Width);
        using var fill = new SolidBrush(Color.FromArgb(35, Color.Lime));
        foreach (var band in Bands)
        {
            e.Graphics.FillRectangle(fill, band);
            e.Graphics.DrawRectangle(pen, band);
        }
        if (anchor is not null)
        {
            pen.DashStyle = DashStyle.Dash;
            e.Graphics.DrawRectangle(pen, Between(anchor.Value, current));
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) image?.Dispose();
        base.Dispose(disposing);
    }
}
