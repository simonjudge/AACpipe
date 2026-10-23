using System.ComponentModel;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace AACpipe.Ocr;

internal sealed record WindowTarget(nint Handle, uint ProcessId, string Title)
{
    public override string ToString() => Title;
}

internal enum CaptureMode
{
    // PrintWindow: works even when covered, but many apps (including Grid 3) refuse it.
    Window,
    // Copy of the selected window's visible on-screen pixels, after verifying nothing covers it.
    Screen,
}

internal static class WindowCapture
{
    internal static List<WindowTarget> ListWindows()
    {
        var windows = new List<WindowTarget>();
        var ownProcess = (uint)Environment.ProcessId;
        if (!EnumWindows((handle, _) =>
        {
            var title = new StringBuilder(512);
            GetWindowText(handle, title, title.Capacity);
            GetWindowThreadProcessId(handle, out var pid);
            if (IsWindowVisible(handle) && title.Length != 0 && pid != ownProcess)
                windows.Add(new WindowTarget(handle, pid, title.ToString()));
            return true;
        }, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not list application windows.");
        return windows.OrderBy(window => window.Title).ToList();
    }

    // Used during setup. Window capture is preferred because it works while the window is covered, but some apps
    // (including Grid 3) refuse it, return blank frames or return stale frames. It is only trusted if it matches
    // what is actually on screen; otherwise the visible screen pixels are used.
    internal static (Bitmap Frame, CaptureMode Mode) CaptureForSetup(WindowTarget target)
    {
        var size = ClientSize(target, null);
        // This process was just clicked, so Windows allows it to bring the AAC window to the front.
        if (GetForegroundWindow() != target.Handle && SetForegroundWindow(target.Handle)) Thread.Sleep(300);
        var screen = CopyFromScreen(target, size, null);
        Bitmap? printed = null;
        try { printed = PrintClient(target, size); }
        catch (InvalidOperationException) { }
        if (printed is not null && !IsUniform(printed) && (!FullyVisible(target, size) ||
            Recognizer.DifferenceFraction(Recognizer.Pixels(printed), Recognizer.Pixels(screen)) <= 0.05))
        {
            screen.Dispose();
            return (printed, CaptureMode.Window);
        }
        printed?.Dispose();
        return (screen, CaptureMode.Screen);
    }

    // Returns the mode actually used: window capture permanently falls back to screen capture if the app stops providing it.
    internal static (Bitmap Frame, CaptureMode Mode) Capture(WindowTarget target, CaptureMode mode, Size expectedSize, IReadOnlyList<Rectangle> regions)
    {
        var size = ClientSize(target, expectedSize);
        if (mode == CaptureMode.Window)
        {
            try
            {
                var printed = PrintClient(target, size);
                if (!IsUniform(printed)) return (printed, CaptureMode.Window);
                printed.Dispose();
            }
            catch (InvalidOperationException) { }
        }
        return (CopyFromScreen(target, size, regions), CaptureMode.Screen);
    }

    private static bool FullyVisible(WindowTarget target, Size size)
    {
        try
        {
            EnsureVisible(target, ClientOrigin(target), new Rectangle(Point.Empty, size));
            return true;
        }
        catch (InvalidOperationException) { return false; }
    }

    private static Size ClientSize(WindowTarget target, Size? expectedSize)
    {
        GetWindowThreadProcessId(target.Handle, out var pid);
        if (pid != target.ProcessId || !IsWindow(target.Handle) || !IsWindowVisible(target.Handle) || IsIconic(target.Handle))
            throw new InvalidOperationException("The selected window is unavailable or minimised. Restore it and resume.");
        if (!GetClientRect(target.Handle, out var rect))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read the selected window size.");
        var size = new Size(rect.Right - rect.Left, rect.Bottom - rect.Top);
        if (size.Width < 1 || size.Height < 1 || size.Width > 8192 || size.Height > 8192)
            throw new InvalidOperationException("Unsupported window size.");
        if (expectedSize.HasValue && expectedSize != size)
            throw new InvalidOperationException("The window size changed. Capture and calibrate again.");
        return size;
    }

    private static Bitmap PrintClient(WindowTarget target, Size size)
    {
        var bitmap = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb);
        try
        {
            using var graphics = Graphics.FromImage(bitmap);
            var dc = graphics.GetHdc();
            try
            {
                if (!PrintWindow(target.Handle, dc, 3))
                    throw new InvalidOperationException("This application did not provide a window capture.");
            }
            finally { graphics.ReleaseHdc(dc); }
            return bitmap;
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }
    }

    private static Point ClientOrigin(WindowTarget target)
    {
        var origin = new NativePoint();
        if (!ClientToScreen(target.Handle, ref origin))
            throw new InvalidOperationException("Could not locate the selected window on screen.");
        return new Point(origin.X, origin.Y);
    }

    private static Bitmap CopyFromScreen(WindowTarget target, Size size, IReadOnlyList<Rectangle>? mustBeVisible)
    {
        var origin = ClientOrigin(target);
        var regions = mustBeVisible ?? [];
        foreach (var region in regions) EnsureVisible(target, origin, region);
        var bitmap = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb);
        try
        {
            using (var graphics = Graphics.FromImage(bitmap))
                graphics.CopyFromScreen(origin, Point.Empty, size, CopyPixelOperation.SourceCopy);
            // Reject the frame if the window moved or became covered while it was being copied.
            if (ClientOrigin(target) != origin)
                throw new InvalidOperationException("The selected window moved during capture.");
            foreach (var region in regions) EnsureVisible(target, origin, region);
            return bitmap;
        }
        catch (Win32Exception error)
        {
            bitmap.Dispose();
            throw new InvalidOperationException("The screen could not be captured (it may be locked or asleep).", error);
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }
    }

    // Screen capture would otherwise read whatever window is on top, so every sample point must belong to the target.
    private static void EnsureVisible(WindowTarget target, Point origin, Rectangle region)
    {
        const int steps = 6;
        for (var row = 0; row <= steps; row++)
            for (var column = 0; column <= steps; column++)
            {
                var point = new NativePoint
                {
                    X = origin.X + region.Left + Math.Min(region.Width - 1, region.Width * column / steps),
                    Y = origin.Y + region.Top + Math.Min(region.Height - 1, region.Height * row / steps),
                };
                if (!BelongsToTarget(WindowFromPoint(point), target.Handle))
                    throw new InvalidOperationException("Another window is covering the chat area. Move it away; nothing is sent while covered.");
            }
    }

    private static bool BelongsToTarget(nint hit, nint target)
    {
        if (hit == 0) return false;
        var root = GetAncestor(hit, 2);
        // Accept the target itself and popups it owns (for example its own menus), but not unrelated windows.
        for (var owner = root; owner != 0; owner = GetWindow(owner, 4))
            if (owner == target) return true;
        return false;
    }

    internal static bool IsUniform(Bitmap image)
    {
        var pixels = Recognizer.Pixels(image);
        for (var i = 4; i < pixels.Length; i += 4)
            if (pixels[i] != pixels[0] || pixels[i + 1] != pixels[1] || pixels[i + 2] != pixels[2]) return false;
        return true;
    }

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(nint handle);

    private delegate bool EnumWindowCallback(nint handle, nint parameter);
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint { public int X, Y; }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowCallback callback, nint parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(nint handle, StringBuilder text, int count);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint handle, out uint processId);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(nint handle);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint handle);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(nint handle);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetClientRect(nint handle, out Rect rectangle);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PrintWindow(nint handle, nint dc, uint flags);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClientToScreen(nint handle, ref NativePoint point);
    [DllImport("user32.dll")]
    private static extern nint WindowFromPoint(NativePoint point);
    [DllImport("user32.dll")]
    private static extern nint GetAncestor(nint handle, uint flags);
    [DllImport("user32.dll")]
    private static extern nint GetWindow(nint handle, uint command);
}
