using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace AACpipe.Ocr;

internal sealed class BridgeClient(string executable)
{
    internal Task<BridgeSnapshot> SendAsync(string text, CancellationToken cancellationToken) =>
        ExecuteAsync(text, cancellationToken);

    internal Task<BridgeSnapshot> ProbeAsync(CancellationToken cancellationToken) =>
        ExecuteAsync(null, cancellationToken);

    private async Task<BridgeSnapshot> ExecuteAsync(string? text, CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            StandardInputEncoding = new UTF8Encoding(false, true),
            RedirectStandardError = true,
            RedirectStandardOutput = true
        };
        start.ArgumentList.Add(text is null ? "--status" : text.Length == 0 ? "--clear" : "--sentence");
        if (text is { Length: > 0 }) start.ArgumentList.Add("--text-stdin");
        start.ArgumentList.Add("--json");
        start.ArgumentList.Add("--preserve-window");
        start.ArgumentList.Add("--no-autostart");
        using var process = Process.Start(start) ?? throw new IOException("Could not start the AACpipe bridge.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        // Drain both streams concurrently. Never include their contents (possibly sensitive) in diagnostics.
        var errors = process.StandardError.ReadToEndAsync(timeout.Token);
        var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
        try
        {
            if (text is { Length: > 0 }) await process.StandardInput.WriteAsync(text.AsMemory(), timeout.Token);
            process.StandardInput.Close();
            await process.WaitForExitAsync(timeout.Token);
            await Task.WhenAll(errors, output);
            if (process.ExitCode != 0)
                throw new IOException($"AACpipe bridge failed (exit {process.ExitCode}). Check AACpipe is running and the bridge is up to date.");
            return ParseSnapshot(await output);
        }
        catch
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            // Observe redirected-read cancellation before releasing the process.
            try { await Task.WhenAll(errors, output); }
            catch (OperationCanceledException) { }
            throw;
        }
    }

    internal static BridgeSnapshot ParseSnapshot(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.GetProperty("v").GetInt32() != 1 || !root.GetProperty("ok").GetBoolean())
                throw new IOException("Unexpected bridge response.");
            var state = root.GetProperty("state").GetString();
            var revision = root.GetProperty("revision").GetString();
            if (state is not ("IDLE" or "COMPOSING" or "SPEAKING") ||
                revision is null || !ulong.TryParse(revision, System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture, out var number) ||
                number.ToString(System.Globalization.CultureInfo.InvariantCulture) != revision)
                throw new IOException("Invalid bridge snapshot.");
            return new BridgeSnapshot(state, revision);
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            throw new IOException("Invalid bridge response. Install the updated AACpipe bridge.", error);
        }
    }
}

internal sealed record BridgeSnapshot(string State, string Revision);
