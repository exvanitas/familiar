# The driver's steps for the network side: the native confirms, read and answered through UI
# Automation. Dot-sourced by driver.ps1, whose step dispatch falls through to Do-NetStep. Runner only.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Language CSharp @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class WN {
  delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32")] static extern bool EnumWindows(E e, IntPtr l);
  [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowTextW(h, s, 512); return s.ToString(); }
  static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }
  /* a shown window of this process with this class, or 0 */
  public static long Shown(uint pid, string cls) {
    long found = 0;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h) && Class(h) == cls) { found = h.ToInt64(); return false; } return true; }, IntPtr.Zero);
    return found;
  }
  /* a shown window of any process with this class, or 0: popup menus */
  public static long AnyShown(string cls) {
    long found = 0;
    EnumWindows((h, l) => { if (IsWindowVisible(h) && Class(h) == cls) { found = h.ToInt64(); return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string OwnerTitle(long h) { var o = GetWindow(new IntPtr(h), 4); return o == IntPtr.Zero ? "" : Text(o); }
  public static bool Topmost(long h) { return (GetLong(new IntPtr(h), -20).ToInt64() & 0x8) != 0; }
  public static bool Enabled(long h) { return IsWindowEnabled(new IntPtr(h)); }
  public static string TitleOf(long h) { return Text(new IntPtr(h)); }
  [DllImport("user32")] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr r);
  /* whether the window's thread answers within 2 s */
  public static bool Responds(long h) { IntPtr r; return SendMessageTimeoutW(new IntPtr(h), 0, IntPtr.Zero, IntPtr.Zero, 2, 2000, out r) != IntPtr.Zero; }
}
"@

$UIA = [System.Windows.Automation.AutomationElement]
Add-Type -AssemblyName System.Drawing
$script:shotN = 0

# The whole screen, to the results, for a dialog that went wrong.
function Screen-Shot([string]$name) {
  try {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
  } catch { Write-Host "screenshot: $_" }
}

function Uia-All($el, $type) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $type)
  return @($el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond))
}

function Dialog-Texts($el) {
  return @(Uia-All $el ([System.Windows.Automation.ControlType]::Text) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
}

function Dialog-Button($el, [string]$name) {
  return Uia-All $el ([System.Windows.Automation.ControlType]::Button) | Where-Object { ($_.Current.Name -replace '&', '') -eq $name } | Select-Object -First 1
}

function Invoke-El($b) {
  $p = $null
  if ($b -and $b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return $true }
  return $false
}

# A confirm of the exe's, waited for up to $ms. Its handle, or 0.
function Wait-Dialog([int]$ms) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  do {
    $h = [WN]::Shown([uint32]$script:proc.Id, '#32770')
    if ($h -and [WN]::TitleOf($h) -eq 'Familiar') { return $h }
    Start-Sleep -Milliseconds 100
  } while ($t.ElapsedMilliseconds -lt $ms)
  return 0
}

function Do-NetStep($action, $a) {
  switch ($action) {
    'dialog' {
      $out = [ordered]@{ found = $false; title = ''; texts = @(); details = ''; buttons = @(); approveAtStart = $false; approveLater = $false; invokedEarly = ''; owner = ''; topmost = $false; answered = '' }
      $wait = if ($a.act -eq 'none') { 2500 } else { 15000 }
      $h = Wait-Dialog $wait
      if (-not $h) { return $out }
      $out.found = $true
      $script:shotN++
      Write-Host "dialog $($a.act): found $h"
      if (-not [WN]::Responds($h)) {
        Screen-Shot "dialog-$($script:shotN)-hung"
        $out.answered = 'the dialog does not respond'
        return $out
      }
      $el = $UIA::FromHandle([IntPtr]$h)
      $approve = Dialog-Button $el $a.approve
      $out.approveAtStart = [bool]($approve -and $approve.Current.IsEnabled)
      $out.owner = [WN]::OwnerTitle($h)
      $out.topmost = [WN]::Topmost($h)
      if ($a.act -eq 'enter') {
        # A click within the first second must do nothing.
        try { if (Invoke-El $approve) { Start-Sleep -Milliseconds 300; $out.invokedEarly = if ([WN]::Shown([uint32]$script:proc.Id, '#32770')) { 'no effect' } else { 'closed it' } } else { $out.invokedEarly = 'no invoke pattern' } }
        catch { $out.invokedEarly = 'refused' }
      }
      Start-Sleep -Milliseconds 1300
      if ($out.invokedEarly -ne 'closed it') {
        $approve = Dialog-Button $el $a.approve
        $out.approveLater = [bool]($approve -and $approve.Current.IsEnabled)
        $out.texts = Dialog-Texts $el
        $out.buttons = @(Uia-All $el ([System.Windows.Automation.ControlType]::Button) | ForEach-Object { @{ name = $_.Current.Name; enabled = $_.Current.IsEnabled } })
        if ($a.details) {
          $more = Dialog-Button $el 'Show details'
          if ($more) { [void](Invoke-El $more); Start-Sleep -Milliseconds 400 }
          $after = Dialog-Texts $el
          $out.details = (@($after | Where-Object { $out.texts -notcontains $_ }) -join "`n")
        }
      }
      if ($script:shotN -le 3) { Screen-Shot "dialog-$($script:shotN)" }
      switch ($a.act) {
        'approve' { $out.answered = [string](Invoke-El (Dialog-Button $el $a.approve)) }
        'refuse' { $out.answered = [string](Invoke-El (Dialog-Button $el $a.refuse)) }
        'close' { [void][W]::Post($h, 0x10, 0, 0); $out.answered = 'closed' }
        'enter' {
          [void][W]::Foreground($h)
          Start-Sleep -Milliseconds 300
          [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
          $out.answered = 'enter'
        }
        default { $out.answered = 'held' }
      }
      return $out
    }
    'winstate' {
      $o = [ordered]@{}
      foreach ($t in $a.titles) {
        $h = [W]::FindByTitle($t)
        $o[$t] = [ordered]@{ found = [bool]$h; topmost = $(if ($h) { [WN]::Topmost($h) } else { $false }); enabled = $(if ($h) { [WN]::Enabled($h) } else { $false }) }
      }
      return $o
    }
    'tray-ask-again' {
      # Right-click the tray icon the way the shell does, then pick the item in its menu.
      $h = [W]::FindClass([uint32]$script:proc.Id, 'tray_icon_app')
      if (-not $h) { return @{ done = $false; how = 'no tray window' } }
      [void][W]::Post($h, 6002, 0, 0x204)
      [void][W]::Post($h, 6002, 0, 0x205)
      $menu = 0
      for ($i = 0; $i -lt 50 -and -not $menu; $i++) { Start-Sleep -Milliseconds 100; $menu = [WN]::AnyShown('#32768') }
      if (-not $menu) { return @{ done = $false; how = 'no menu appeared' } }
      $el = $UIA::FromHandle([IntPtr]$menu)
      $item = Uia-All $el ([System.Windows.Automation.ControlType]::MenuItem) | Where-Object { $_.Current.Name -eq 'Let Familiar ask again' } | Select-Object -First 1
      if (-not $item) { return @{ done = $false; how = 'the menu has no "Let Familiar ask again": ' + ((Uia-All $el ([System.Windows.Automation.ControlType]::MenuItem) | ForEach-Object { $_.Current.Name }) -join ', ') } }
      $ok = Invoke-El $item
      Start-Sleep -Milliseconds 500
      return @{ done = $ok; how = 'picked from the tray menu through UI Automation' }
    }
    default { return $null }
  }
}
