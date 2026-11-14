# The Win32 calls the driver needs. Runs on the Actions Windows runner only.
Add-Type -Language CSharp @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }
  delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32")] static extern bool EnumWindows(E e, IntPtr l);
  [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32")] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32")] static extern bool EnumChildWindows(IntPtr h, E e, IntPtr l);
  static W() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }

  static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowTextW(h, s, 512); return s.ToString(); }
  static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }
  static List<IntPtr> All() { var o = new List<IntPtr>(); EnumWindows((h, l) => { o.Add(h); return true; }, IntPtr.Zero); return o; }
  static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }

  public static long FindByTitle(string title) { foreach (var h in All()) if (Text(h) == title && IsWindowVisible(h)) return h.ToInt64(); return 0; }
  /* a top-level window of this process with this class, shown or not */
  public static long FindClass(uint pid, string cls) { foreach (var h in All()) if (Pid(h) == pid && Class(h) == cls) return h.ToInt64(); return 0; }
  /* every shown top-level window of these processes, as "pid class title" */
  public static string[] Visible(uint[] pids) {
    var set = new HashSet<uint>(pids); var o = new List<string>();
    foreach (var h in All()) { var p = Pid(h); if (set.Contains(p) && IsWindowVisible(h)) o.Add(p + " " + Class(h) + " " + Text(h)); }
    return o.ToArray();
  }
  /* a dialog box of this process */
  public static long Dialog(uint pid) { foreach (var h in All()) if (Pid(h) == pid && Class(h) == "#32770" && IsWindowVisible(h)) return h.ToInt64(); return 0; }
  /* the text of a message box: its Static children */
  public static string DialogText(long d) {
    var o = new StringBuilder();
    EnumChildWindows(new IntPtr(d), (h, l) => { if (Class(h) == "Static") o.Append(Text(h)).Append(' '); return true; }, IntPtr.Zero);
    return o.ToString();
  }
  /* WM_COMMAND with IDOK (1) or IDCANCEL (2) */
  public static void Press(long h, int id) { PostMessageW(new IntPtr(h), 0x111, new IntPtr(id), IntPtr.Zero); }
  public static bool Post(long h, uint m, long w, long l) { return PostMessageW(new IntPtr(h), m, new IntPtr(w), new IntPtr(l)); }
  public static long CurrentForeground() { return GetForegroundWindow().ToInt64(); }
  public static bool Foreground(long h) { ShowWindow(new IntPtr(h), 9); return SetForegroundWindow(new IntPtr(h)); }
  public static RECT Rect(long h) { RECT r; GetWindowRect(new IntPtr(h), out r); return r; }
  /* a left click, true if the input went in */
  public static bool Click(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(200);
    var down = new INPUT { type = 0, mi = new MOUSEINPUT { flags = 2 } };
    var up = new INPUT { type = 0, mi = new MOUSEINPUT { flags = 4 } };
    uint a = SendInput(1, new[] { down }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(80);
    uint b = SendInput(1, new[] { up }, Marshal.SizeOf(typeof(INPUT)));
    return a == 1 && b == 1;
  }
}
"@
