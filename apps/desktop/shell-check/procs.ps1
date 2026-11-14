# The driver's half of procs.ts: server starts, links, saving, system state, wake, notifications
# and autostart. Dot-sourced by driver.ps1, which calls Run-ProcChecks once and hands it the steps
# in $procSteps. Runs on the Actions Windows runner only. The SMB counts are the shell-win
# workflow's (../shell-win/smb-counts.ps1): pktmon can't see SMB to the runner's own share.
. (Join-Path $PSScriptRoot '..\shell-win\smb-counts.ps1')

Add-Type -Language CSharp @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class P {
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [DllImport("kernel32", SetLastError=true)] static extern bool DeviceIoControl(IntPtr h, uint code, byte[] i, int il, IntPtr o, int ol, out int r, IntPtr ov);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref BASIC i, int l);
  [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, uint pid);
  [DllImport("user32")] static extern bool EnumChildWindows(IntPtr h, E e, IntPtr l);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32")] static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool E(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct BASIC { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr Min, Max; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }

  /* An empty folder made a junction to any target, which mklink and New-Item won't write. Writing
     it touches only this folder. */
  public static string MakeJunction(string dir, string sub, string print) {
    var h = CreateFileW(dir, 0x40000000, 0, IntPtr.Zero, 3, 0x00200000 | 0x02000000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return "open failed " + Marshal.GetLastWin32Error();
    var s = Encoding.Unicode.GetBytes(sub); var p = Encoding.Unicode.GetBytes(print);
    int path = s.Length + 2 + p.Length + 2;
    var b = new byte[16 + path];
    BitConverter.GetBytes(0xA0000003u).CopyTo(b, 0);
    BitConverter.GetBytes((ushort)(8 + path)).CopyTo(b, 4);
    BitConverter.GetBytes((ushort)0).CopyTo(b, 8);
    BitConverter.GetBytes((ushort)s.Length).CopyTo(b, 10);
    BitConverter.GetBytes((ushort)(s.Length + 2)).CopyTo(b, 12);
    BitConverter.GetBytes((ushort)p.Length).CopyTo(b, 14);
    s.CopyTo(b, 16); p.CopyTo(b, 16 + s.Length + 2);
    int r; bool ok = DeviceIoControl(h, 0x000900A4, b, b.Length, IntPtr.Zero, 0, out r, IntPtr.Zero);
    int e = Marshal.GetLastWin32Error(); CloseHandle(h);
    return ok ? "" : "set failed " + e;
  }

  /* Puts a running process in a job that allows no more processes than it has: one. */
  public static string LimitJob(uint pid) {
    var j = CreateJobObjectW(IntPtr.Zero, null);
    if (j == IntPtr.Zero) return "job " + Marshal.GetLastWin32Error();
    var i = new BASIC { LimitFlags = 0x8, ActiveProcessLimit = 1 };
    if (!SetInformationJobObject(j, 2, ref i, Marshal.SizeOf(typeof(BASIC)))) return "limit " + Marshal.GetLastWin32Error();
    var p = OpenProcess(0x0100 | 0x0001, false, pid);
    if (p == IntPtr.Zero) return "open " + Marshal.GetLastWin32Error();
    if (!AssignProcessToJobObject(j, p)) return "assign " + Marshal.GetLastWin32Error();
    return "";
  }

  [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  /* The file name box of a common save dialog: the Edit with id 1001 (edt1), or the one inside the
     file name combo box (cmb13, 1148), never the address bar's. What it reads after, or null. */
  public static string SetFileName(long dialog, string text) {
    IntPtr found = IntPtr.Zero, combo = IntPtr.Zero;
    EnumChildWindows(new IntPtr(dialog), (h, l) => {
      if (Class(h) != "Edit") return true;
      if (found == IntPtr.Zero && GetDlgCtrlID(h) == 1001) found = h;
      if (combo == IntPtr.Zero && GetDlgCtrlID(GetParent(h)) == 1148) combo = h;
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) found = combo;
    if (found == IntPtr.Zero) return null;
    SendMessageW(found, 0x000C, IntPtr.Zero, text);
    var s = new StringBuilder(1024); GetWindowTextW(found, s, 1024);
    return s.ToString();
  }

  /* BM_CLICK on the button with id 1, the dialog's OK (Save or Open). */
  public static bool ClickOk(long dialog) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(new IntPtr(dialog), (h, l) => { if (found == IntPtr.Zero && Class(h) == "Button" && GetDlgCtrlID(h) == 1) found = h; return true; }, IntPtr.Zero);
    if (found == IntPtr.Zero) { PostMessageW(new IntPtr(dialog), 0x111, new IntPtr(1), IntPtr.Zero); return false; }
    PostMessageW(found, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    return true;
  }
}
"@

$script:smb = $null
$script:listener = $null

# The share, a mapped drive and links to them, made before any count is taken, so their own SMB
# traffic is in the baseline. The share is this runner's C$, so its root is C:\.
function Setup-Smb {
  $fx = Join-Path $tmp 'smb'
  New-Item -ItemType Directory -Force "$fx\local\bin" | Out-Null
  Set-Content "$fx\local\bin\tool.exe" 'a placeholder, never run'
  New-Item -ItemType Directory -Force 'C:\familiar-fx' | Out-Null
  Set-Content 'C:\familiar-fx\tool.exe' 'a placeholder, never run'
  $unc = '\\localhost\C$'
  $how = 'Z: mapped to \\localhost\C$'
  try { New-SmbMapping -LocalPath 'Z:' -RemotePath $unc -ErrorAction Stop | Out-Null }
  catch {
    New-Item -ItemType Directory -Force 'C:\familiar-share\familiar-fx' | Out-Null
    Set-Content 'C:\familiar-share\familiar-fx\tool.exe' 'a placeholder, never run'
    New-SmbShare -Name familiar-share -Path 'C:\familiar-share' -FullAccess Everyone | Out-Null
    $unc = '\\localhost\familiar-share'
    $how = "Z: mapped to $unc (C$ refused: $_)"
    New-SmbMapping -LocalPath 'Z:' -RemotePath $unc -ErrorAction Stop | Out-Null
  }
  Get-ChildItem 'Z:\familiar-fx' | Out-Null
  New-Item -ItemType Junction -Path "$fx\j-local" -Target "$fx\local" | Out-Null
  New-Item -ItemType SymbolicLink -Path "$fx\s-share" -Target $unc | Out-Null
  New-Item -ItemType SymbolicLink -Path "$fx\s-mapped" -Target 'Z:\' | Out-Null
  New-Item -ItemType Directory -Force "$fx\j-share" | Out-Null
  $made = [P]::MakeJunction("$fx\j-share", "\??\UNC\$($unc.TrimStart('\'))\", "$unc\")
  if ($made) { throw "the junction to the share: $made" }
  $script:smb = @{ unc = $unc; mapped = 'Z'; jShare = "$fx\j-share"; sShare = "$fx\s-share"; sMapped = "$fx\s-mapped"; jLocal = "$fx\j-local"; how = $how }
}

# Every process below the exe but WebView2's, as Process objects held from now on.
function Tree-Below([int]$root) {
  $all = @(Get-CimInstance Win32_Process)
  $out = @(); $front = @($root)
  while ($front.Count) {
    $next = @()
    foreach ($q in $front) { foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $q -and $_.Name -ne 'msedgewebview2.exe' }) { $out += $c; $next += [int]$c.ProcessId } }
    $front = $next
  }
  return $out
}

function Find-Dialog([int]$ms) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  do {
    $h = [W]::Dialog([uint32]$script:proc.Id)
    if ($h) { return $h }
    Start-Sleep -Milliseconds 100
  } while ($t.ElapsedMilliseconds -lt $ms)
  return 0
}

$procSteps = @{
  'proc-paths' = {
    param($a)
    $repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
    @{ repo = $repo; mainTs = (Join-Path $repo 'tools\fake-mcp-server\src\main.ts'); node = (Get-Command node -CommandType Application | Select-Object -First 1).Source; tmp = $tmp; exeDir = (Split-Path $Exe); smb = $script:smb }
  }
  'dialog' = {
    param($a)
    $h = Find-Dialog ([int]$a.within)
    if (-not $h) { return @{ shown = $false; text = '' } }
    $text = [W]::DialogText($h)
    $press = if ($a.press -eq 'yes') { 6 } else { 7 }
    [W]::Press($h, $press)
    for ($i = 0; $i -lt 30 -and [W]::Dialog([uint32]$script:proc.Id) -eq $h; $i++) { Start-Sleep -Milliseconds 100 }
    @{ shown = $true; text = $text; pressed = $(if ($press -eq 6) { 'yes' } else { 'no' }) }
  }
  'smb-save' = { param($a); $c = Save-SmbCounts $a.name; @{ opens = $c.opens } }
  'smb-compare' = {
    param($a)
    $d = Compare-SmbCounts (Read-SmbCounts $a.before) (Save-SmbCounts $a.after)
    @{ opens = $d.opens; new = @($d.new) }
  }
  'smb-control' = {
    param($a)
    $before = Save-SmbCounts 'proc-control-before'
    Get-Content 'Z:\familiar-fx\tool.exe' | Out-Null
    Get-ChildItem ($script:smb.unc -replace '^\\\\localhost', '\\127.0.0.1') | Out-Null
    Start-Sleep -Milliseconds 500
    $d = Compare-SmbCounts $before (Save-SmbCounts 'proc-control-after')
    @{ opens = $d.opens; new = @($d.new) }
  }
  'node-children' = {
    param($a)
    $kids = @(Tree-Below $script:proc.Id | Where-Object { $_.Name -eq 'node.exe' })
    $suspended = 0
    foreach ($k in $kids) {
      $threads = @(Get-CimInstance Win32_Thread -Filter "ProcessHandle='$($k.ProcessId)'")
      if ($threads.Count -and -not @($threads | Where-Object { $_.ThreadWaitReason -ne 5 }).Count) { $suspended++ }
    }
    @{ count = $kids.Count; suspended = $suspended }
  }
  'listen-start' = {
    param($a)
    $script:listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $script:listener.Start()
    @{ port = $script:listener.LocalEndpoint.Port }
  }
  'listen-count' = {
    param($a)
    $n = 0; $t = [Diagnostics.Stopwatch]::StartNew()
    while ($t.ElapsedMilliseconds -lt [int]$a.ms) {
      while ($script:listener.Pending()) { $script:listener.AcceptTcpClient().Close(); $n++ }
      if ($a.until -and $n -ge [int]$a.until) { break }
      Start-Sleep -Milliseconds 100
    }
    @{ count = $n }
  }
  'listen-stop' = {
    param($a)
    if ($script:listener) { $script:listener.Stop() }
    # The browser open_url started, with the runner's default profile.
    Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    @{}
  }
  'save-dialog' = {
    param($a)
    $h = Find-Dialog 15000
    if (-not $h) { return @{ shown = $false; why = 'no dialog' } }
    Start-Sleep -Milliseconds 500
    $typed = [P]::SetFileName($h, $a.path)
    if ($null -eq $typed) { [W]::Press($h, 2); return @{ shown = $false; why = 'no file name box' } }
    Start-Sleep -Milliseconds 200
    [void][P]::ClickOk($h)
    for ($i = 0; $i -lt 50 -and [W]::Dialog([uint32]$script:proc.Id) -eq $h; $i++) { Start-Sleep -Milliseconds 100 }
    $still = [W]::Dialog([uint32]$script:proc.Id) -eq $h
    if ($still) { [W]::Press($h, 2); return @{ shown = $false; why = 'the dialog stayed: ' + [W]::DialogText($h) } }
    Start-Sleep -Milliseconds 500
    @{ shown = $true; typed = $typed }
  }
  'file-length' = {
    param($a)
    if (Test-Path -LiteralPath $a.path) { return @{ length = (Get-Item -LiteralPath $a.path).Length; found = @() } }
    $found = @()
    if ($a.find) {
      foreach ($d in @("$env:USERPROFILE\Documents", "$env:USERPROFILE\Desktop", "$env:USERPROFILE\Downloads", $tmp)) {
        $found += @(Get-ChildItem -LiteralPath $d -Filter $a.find -Recurse -Depth 3 -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
      }
    }
    @{ length = -1; found = $found }
  }
  'run-entry' = {
    param($a)
    $v = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name Familiar -ErrorAction SilentlyContinue).Familiar
    @{ value = [string]$v }
  }
  'toast-setting' = {
    param($a)
    # WinRT projections are Windows PowerShell's, not PowerShell 7's.
    $cmd = "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('dev.exvanitas.familiar').Setting"
    $setting = (& powershell.exe -NoProfile -Command $cmd 2>&1 | Out-String).Trim()
    $key = Get-ItemProperty 'HKCU:\Software\Classes\AppUserModelId\dev.exvanitas.familiar' -ErrorAction SilentlyContinue
    @{ setting = $setting; key = "DisplayName=$($key.DisplayName) IconUri set=$([bool]$key.IconUri)" }
  }
  'job-limit' = {
    param($a)
    $why = [P]::LimitJob([uint32]$script:proc.Id)
    @{ done = ($why -eq ''); why = $why }
  }
  'kill-tree' = {
    param($a)
    $tree = @(Tree-Below $script:proc.Id | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_ })
    foreach ($t in $tree) { [void]$t.Handle }
    $names = ($tree | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join ' '
    Stop-Process -Id $script:proc.Id -Force
    Start-Sleep -Seconds 2
    $left = @($tree | Where-Object { -not $_.HasExited })
    Result $(if ($tree.Count -ge 1 -and $left.Count -eq 0) { 'PASS' } else { 'FAIL' }) 'security.server.kill' "familiar.exe killed hard with a slow call in flight: $($tree.Count) processes below it ($names), $($left.Count) left 2 s later"
    foreach ($l in $left) { Stop-Process -Id $l.Id -Force -ErrorAction SilentlyContinue }
    @{}
  }
}

function Run-ProcChecks {
  Write-Host '--- server, file, system and wake checks'
  Setup-Smb
  $env:FAMILIAR_CHECK_PARENT_ONLY = 'only-in-familiar'
  try {
    $data = Join-Path $tmp 'proc-data'
    $log = Join-Path $Out 'proc-main.log'
    [void](Run-Phase 'proc-main' $log @('--app-dir', $App, '--data-dir', $data, '--log', $log, '--seconds', '900', '--phase', 'proc-main') 960)
    [void](No-Strays 'proc-main')

    # An unreadable approval store: every setup asks again.
    Set-Content (Join-Path $data 'shell\servers.json') 'not a store {'
    $log = Join-Path $Out 'proc-files.log'
    [void](Run-Phase 'proc-files' $log @('--app-dir', $App, '--data-dir', (Join-Path $tmp 'proc-files-data'), '--log', $log, '--seconds', '300', '--phase', 'proc-files') 330)
    [void](No-Strays 'proc-files')

    $log = Join-Path $Out 'proc-recover.log'
    [void](Run-Phase 'proc-recover' $log @('--app-dir', $App, '--data-dir', $data, '--log', $log, '--seconds', '120', '--phase', 'proc-recover') 150)
    [void](No-Strays 'proc-recover')

    $log = Join-Path $Out 'proc-kill.log'
    [void](Run-Phase 'proc-kill' $log @('--app-dir', $App, '--data-dir', (Join-Path $tmp 'proc-kill-data'), '--log', $log, '--seconds', '180', '--phase', 'proc-kill') 210)
    if (-not ($results | Where-Object { $_ -like '* security.server.kill *' })) { Result 'FAIL' 'security.server.kill' 'the kill never happened' }
    Start-Sleep -Seconds 5
    Ours | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    $log = Join-Path $Out 'proc-wake.log'
    [void](Run-Phase 'proc-wake' $log @('--app-dir', $App, '--data-dir', (Join-Path $tmp 'proc-wake-data'), '--log', $log, '--seconds', '780', '--phase', 'proc-wake') 840)
    [void](No-Strays 'proc-wake')
  } finally {
    Remove-Item Env:FAMILIAR_CHECK_PARENT_ONLY -ErrorAction SilentlyContinue
    Remove-SmbMapping -LocalPath 'Z:' -Force -ErrorAction SilentlyContinue
  }
}
