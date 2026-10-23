using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace AACpipe.Ocr;

internal sealed record WindowTarget(nint Handle, uint ProcessId, string Title)
{
    public override string ToString() => Title;
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

    internal static Bitmap Capture(WindowTarget target, Size? expectedSize = null)
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
            throw new InvalidOperationException("The window size changed. Select the text bands and calibrate again.");
        var bitmap = new Bitmap(size.Width, size.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        try
        {
            using var graphics = Graphics.FromImage(bitmap);
            var dc = graphics.GetHdc();
            try
            {
                // Capture only this window's client area, never the desktop or another foreground app.
                if (!PrintWindow(target.Handle, dc, 3))
                    throw new InvalidOperationException("This application did not provide a window capture. Sharing is paused.");
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

    private delegate bool EnumWindowCallback(nint handle, nint parameter);
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

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
}
