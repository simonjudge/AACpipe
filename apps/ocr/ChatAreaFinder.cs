using System.Diagnostics;

namespace AACpipe.Ocr;

// Setup guesses only: the user always sees the result and can change it.
internal static class ChatAreaFinder
{
    private static readonly string[] KnownAacApps =
        ["Grid 3", "Grid3", "Grid", "Mind Express", "MindExpress", "TD Snap", "Snap", "Communicator", "TouchChat", "Boardmaker", "ClaroCom", "Predictable"];

    // Prefers the application in the saved profile, then known AAC applications.
    internal static WindowTarget? GuessWindow(IReadOnlyList<WindowTarget> windows, string? profileProcess)
    {
        WindowTarget? best = null;
        var bestScore = 0;
        foreach (var window in windows)
        {
            string process;
            try
            {
                using var owner = Process.GetProcessById((int)window.ProcessId);
                process = owner.ProcessName;
            }
            catch (ArgumentException) { continue; }
            catch (InvalidOperationException) { continue; }
            var score = Score(process, window.Title, profileProcess);
            if (score > bestScore) (best, bestScore) = (window, score);
        }
        return best;
    }

    internal static int Score(string process, string title, string? profileProcess)
    {
        if (profileProcess is not null && process.Equals(profileProcess, StringComparison.OrdinalIgnoreCase)) return 100;
        for (var i = 0; i < KnownAacApps.Length; i++)
        {
            var name = KnownAacApps[i];
            // Earlier, more specific names score higher; "Grid 3" beats a window that merely starts with "Grid".
            if (process.Equals(name, StringComparison.OrdinalIgnoreCase)) return 80 - i;
            if (title.StartsWith(name + " ", StringComparison.OrdinalIgnoreCase) || title.Equals(name, StringComparison.OrdinalIgnoreCase)) return 50 - i;
        }
        return 0;
    }

    // Finds the message bar: AAC applications almost always show it as a wide box across the top of the window. Looks
    // for the largest rectangle outlined by long horizontal edges (a border or a change of fill colour) that starts in
    // the top part of the window, has matching left and right sides, and is mostly one colour inside.
    internal static Rectangle? FindChatArea(Bitmap frame)
    {
        int width = frame.Width, height = frame.Height;
        if (width < 200 || height < 150) return null;
        var pixels = Recognizer.Pixels(frame);
        bool Edge(int x1, int y1, int x2, int y2)
        {
            int a = (y1 * width + x1) * 4, b = (y2 * width + x2) * 4;
            return Math.Max(Math.Abs(pixels[a] - pixels[b]), Math.Max(Math.Abs(pixels[a + 1] - pixels[b + 1]), Math.Abs(pixels[a + 2] - pixels[b + 2]))) > 28;
        }
        var tolerance = Math.Max(8, width / 50);
        var minWidth = (int)(width * 0.35);
        var runs = new List<(int Y, int Left, int Right)>();
        for (var y = 1; y < height; y++)
        {
            int start = -1, last = -1;
            for (var x = 0; x <= width; x++)
            {
                var edge = x < width && Edge(x, y, x, y - 1);
                if (edge)
                {
                    if (start < 0) start = x;
                    last = x;
                }
                // Small gaps are allowed for anti-aliasing and grid lines crossing the edge.
                else if (start >= 0 && (x - last > 3 || x == width))
                {
                    if (last - start + 1 >= minWidth) runs.Add((y, start, last + 1));
                    start = -1;
                }
            }
        }
        Rectangle? best = null;
        foreach (var top in runs.Where(run => run.Y <= height * 0.4))
            foreach (var bottom in runs.Where(run => run.Y - top.Y >= height * 0.06 && run.Y - top.Y <= height * 0.5))
            {
                if (Math.Abs(top.Left - bottom.Left) > tolerance || Math.Abs(top.Right - bottom.Right) > tolerance) continue;
                var box = Rectangle.FromLTRB(Math.Min(top.Left, bottom.Left), top.Y, Math.Max(top.Right, bottom.Right), bottom.Y);
                if (best is { } current && (long)current.Width * current.Height >= (long)box.Width * box.Height) continue;
                // Rounded corners shorten the horizontal edges, so the sides are searched for near the ends.
                var left = Side(box.Left, -1);
                var right = Side(box.Right, 1);
                if (left is null || right is null || right - left < minWidth) continue;
                box = Rectangle.FromLTRB(left.Value, box.Top, right.Value, box.Bottom);
                if (MostlyOneColour(box)) best = box;

                // The side is the vertical edge nearest the end of the horizontal edges, searching outwards first.
                int? Side(int end, int outward)
                {
                    var rows = Math.Max(1, box.Height - 2 * tolerance);
                    for (var distance = 0; distance <= 2 * tolerance; distance++)
                        foreach (var x in new[] { end + outward * distance, end - outward * distance })
                        {
                            if (x < 1 || x >= width) continue;
                            var hits = 0;
                            for (var y = box.Top + tolerance; y < box.Bottom - tolerance; y++)
                                if (Edge(x, y, x - 1, y)) hits++;
                            if (hits >= rows * 0.6) return x;
                        }
                    // A bar that reaches the window edge has no visible side there.
                    if (outward < 0 && end <= 2 * tolerance) return 0;
                    if (outward > 0 && end >= width - 2 * tolerance) return width;
                    return null;
                }
            }
        if (best is not { } found) return null;
        // Stay inside the border so that it is not part of the area that is read.
        var inset = Math.Max(4, height / 150);
        var inner = Rectangle.Inflate(found, -inset, -inset);
        return inner.Width >= 8 && inner.Height >= 8 ? inner : null;

        bool MostlyOneColour(Rectangle box)
        {
            var counts = new Dictionary<int, int>();
            var total = 0;
            var step = Math.Max(1, Math.Min(box.Width, box.Height) / 60);
            for (var y = box.Top + step; y < box.Bottom - step; y += step)
                for (var x = box.Left + step; x < box.Right - step; x += step)
                {
                    var o = (y * width + x) * 4;
                    // Quantised so that slight shading still counts as one colour.
                    var key = (pixels[o] >> 4) | (pixels[o + 1] >> 4 << 4) | (pixels[o + 2] >> 4 << 8);
                    counts[key] = counts.GetValueOrDefault(key) + 1;
                    total++;
                }
            return total > 0 && counts.Values.Max() >= total * 0.5;
        }
    }
}
