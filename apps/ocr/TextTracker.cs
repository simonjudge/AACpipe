using System.Text;
using System.Text.RegularExpressions;

namespace AACpipe.Ocr;

internal sealed class TextTracker
{
    private string? candidate;
    private TimeSpan candidateSince;
    private int matches;
    private string? acknowledged;
    private TimeSpan? lastObservation;

    internal static string Normalize(string text) => Regex.Replace(text.Trim(), @"\s+", " ");

    internal string? Observe(string text, TimeSpan now)
    {
        text = Normalize(text);
        if (Encoding.UTF8.GetByteCount(text) > 4096)
            throw new InvalidOperationException("Text exceeds AACpipe's 4096-byte display buffer. Nothing was sent.");

        if (text != candidate || lastObservation is null || now - lastObservation > TimeSpan.FromSeconds(1))
        {
            candidate = text;
            candidateSince = now;
            matches = 0;
        }
        lastObservation = now;
        matches++;
        var stable = matches >= 2 && (text.Length != 0 || now - candidateSince >= TimeSpan.FromMilliseconds(750));
        return stable && text != acknowledged ? text : null;
    }

    internal void Acknowledge(string text) => acknowledged = text;

    internal void Invalidate()
    {
        candidate = null;
        lastObservation = null;
        matches = 0;
    }

    internal void Resynchronize()
    {
        Invalidate();
        acknowledged = null;
    }
}
