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
  'pids-alive' = {
    param($a)
    @{ alive = @($a.pids | Where-Object { Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue }) }
  }
  'save-dialog-wait' = {
    param($a)
    @{ found = [bool](Find-Dialog 15000) }
  }
  'save-dialog-cancel' = {
    param($a)
    $h = Find-Dialog 2000
    if ($h) { [W]::Press($h, 2) }
    @{ done = [bool]$h }
  }
  'url-recorder-on' = {
    param($a)
    # Not a recorder after all (run 43609051244: the runner's https association doesn't go
    # through the user's class): from now on, every browser process that starts is read for the
    # URL it was handed. Browsers already running are ended first, so a new one starts.
    Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    $script:browserFrom = Get-Date
    $prog = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction SilentlyContinue).ProgId
    return @{ on = $true; how = "the browser's own command line read back (https user choice: $(if ($prog) { $prog } else { 'none' }))" }
  }
  'url-recorded' = {
    param($a)
    # What each new browser process was handed: the argument after --single-argument, which
    # Windows uses for a URL opened through the shell.
    $t = [Diagnostics.Stopwatch]::StartNew()
    do {
      $urls = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CreationDate -ge $script:browserFrom -and $_.CommandLine -match '--single-argument (.+)$' } | ForEach-Object { if ($_.CommandLine -match '--single-argument (.+)$') { $Matches[1].Trim() } } | Sort-Object -Unique)
      if ($a.until -and $urls.Count -ge [int]$a.until) { break }
      Start-Sleep -Milliseconds 200
    } while ($t.ElapsedMilliseconds -lt [int]$a.ms)
    @{ urls = @($urls) }
  }
  'url-recorder-off' = {
    param($a)
    Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    @{}
  }
  'save-watch-start' = {
    param($a)
    # Any change at the chosen name in the folder, from now until save-watch-stop.
    $script:saveEvents = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
    $w = [IO.FileSystemWatcher]::new($a.dir, '*')
    $w.IncludeSubdirectories = $false
    $w.NotifyFilter = [IO.NotifyFilters]'FileName, LastWrite, Size, CreationTime'
    $q = $script:saveEvents; $name = [string]$a.name
    $script:saveSubs = @(foreach ($e in 'Created', 'Changed', 'Deleted', 'Renamed') {
      Register-ObjectEvent -InputObject $w -EventName $e -MessageData @{ q = $q; name = $name } -Action {
        $n = $Event.SourceEventArgs.Name
        if ($n -and $n.Contains($Event.MessageData.name)) { $Event.MessageData.q.Enqueue("$($Event.SourceEventArgs.ChangeType) $n") }
      }
    })
    $w.EnableRaisingEvents = $true
    $script:saveWatcher = $w
    @{}
  }
  'save-watch-stop' = {
    param($a)
    Start-Sleep -Milliseconds 500
    $script:saveWatcher.EnableRaisingEvents = $false
    foreach ($sub in $script:saveSubs) { Unregister-Event -SourceIdentifier $sub.Name -ErrorAction SilentlyContinue }
    $script:saveWatcher.Dispose()
    @{ events = @($script:saveEvents.ToArray()) }
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
  'save-dialog' = {
    param($a)
    $h = Find-Dialog 15000
    if (-not $h) { return @{ shown = $false; why = 'no dialog' } }
    Start-Sleep -Milliseconds 500
    # The file name box through UI Automation: the Edit with automation id 1001, never the address
    # bar's. If that fails anywhere, the box has the focus when the dialog opens, so keystrokes.
    $how = 'ui automation'; $typed = ''; $note = ''
    try {
      $root = $UIA::FromHandle([IntPtr]$h)
      if (-not $root) { throw 'no automation element for the dialog' }
      $edit = $null
      for ($i = 0; $i -lt 50 -and -not $edit; $i++) {
        $edit = @(Uia-All $root ([System.Windows.Automation.ControlType]::Edit) | Where-Object { $_.Current.AutomationId -eq '1001' }) | Select-Object -First 1
        if (-not $edit) { Start-Sleep -Milliseconds 100 }
      }
      if (-not $edit) { throw 'no edit 1001' }
      $vp = $null
      if (-not $edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -or -not $vp) { throw 'no value pattern' }
      $vp.SetValue([string]$a.path)
      $typed = [string]$vp.Current.Value
      $save = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.AutomationId -eq '1' }) | Select-Object -First 1
      $ip = $null
      if ($save -and $save.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$ip) -and $ip) { $ip.Invoke() } else { [void][P]::ClickOk($h) }
    } catch {
      $note = "ui automation: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber); "
      $how = 'keystrokes'
      [void][W]::Foreground($h)
      Start-Sleep -Milliseconds 300
      $keys = -join ([string]$a.path).ToCharArray().ForEach({ if ('+^%~(){}[]'.IndexOf([string]$_) -ge 0) { '{' + $_ + '}' } else { [string]$_ } })
      [System.Windows.Forms.SendKeys]::SendWait('^a' + $keys + '{ENTER}')
      $typed = '(typed)'
    }
    for ($i = 0; $i -lt 50 -and [W]::Dialog([uint32]$script:proc.Id) -eq $h; $i++) { Start-Sleep -Milliseconds 100 }
    if ([W]::Dialog([uint32]$script:proc.Id) -eq $h) { [W]::Press($h, 2); return @{ shown = $false; why = "${note}the dialog stayed ($how, the box read $typed)" } }
    Start-Sleep -Milliseconds 500
    @{ shown = $true; typed = "$note$typed ($how)" }
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
    # The server, its child and its grandchild, each alive now, held by handle, and everything
    # below them too.
    $named = @($a.pids | ForEach-Object { Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue })
    $tree = @(Tree-Below $script:proc.Id | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_ })
    $below = @(foreach ($n in $named) { Tree-Below $n.Id | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_ } })
    $all = @($named + $tree + $below | Sort-Object Id -Unique)
    foreach ($t in $all) { [void]$t.Handle }
    $aliveBefore = @($named | Where-Object { -not $_.HasExited }).Count
    $names = ($all | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join ' '
    Stop-Process -Id $script:proc.Id -Force
    Start-Sleep -Seconds 2
    $left = @($all | Where-Object { -not $_.HasExited })
    # Any process of the tree, the ones started after the listing above included, carries the
    # token on its command line.
    $tokened = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains([string]$a.token) })
    $ok = $named.Count -eq 3 -and $aliveBefore -eq 3 -and $left.Count -eq 0 -and $tokened.Count -eq 0 -and $a.token
    Result $(if ($ok) { 'PASS' } else { 'FAIL' }) 'security.server.kill' "familiar.exe killed hard with a slow call in flight: the server, its child and its grandchild alive before ($aliveBefore of $($named.Count) of 3 found), $($all.Count) processes listed ($names), $($left.Count) left 2 s later, $($tokened.Count) processes anywhere carrying the tree's token"
    foreach ($l in $left) { Stop-Process -Id $l.Id -Force -ErrorAction SilentlyContinue }
    foreach ($t in $tokened) { Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue }
    @{}
  }
}

# Every file under the folders, and the log, searched for each typed key in UTF-8 and UTF-16, once
# the exe has stopped writing. Any file that can't be listed or read fails the search, and a planted
# key must be found first, or the search proves nothing.
function Search-Keys([string[]]$dirs, [string]$log, [string[]]$keys) {
  $errs = @()
  $files = @(foreach ($d in $dirs) { Get-ChildItem $d -Recurse -File -Force -ErrorAction SilentlyContinue -ErrorVariable +errs }) + @(Get-Item $log)
  $found = @(); $unread = @(); $read = 0
  foreach ($f in $files) {
    try { $b = [IO.File]::ReadAllBytes($f.FullName) } catch { $unread += "$($f.Name): $($_.Exception.Message)"; continue }
    $read++
    $t8 = [Text.Encoding]::UTF8.GetString($b); $t16 = [Text.Encoding]::Unicode.GetString($b)
    $t16b = if ($b.Length -gt 1) { [Text.Encoding]::Unicode.GetString($b, 1, $b.Length - 1) } else { '' }
    foreach ($k in $keys) { if ($t8.Contains($k) -or $t16.Contains($k) -or $t16b.Contains($k)) { $found += $f.Name } }
  }
  return @{ listed = $files.Count; read = $read; unread = @($unread) + @($errs | ForEach-Object { "listing: $($_.Exception.Message)" }); found = @($found | Sort-Object -Unique) }
}

function Check-BlankSearch([string]$data, [string]$log, [string[]]$typed) {
  # This phase must have run to its end, with the page's own check of the output passed, and
  # typed exactly the one key searched for here.
  $done = [bool](Select-String -Path $log -Pattern '\[core\] DONE$' -Quiet)
  $output = @($results | Where-Object { $_ -like 'PASS security.server.blank-output *' }).Count -eq 1
  if (-not $done -or -not $output -or $typed.Count -ne 1) {
    Result 'FAIL' 'security.server.blank-search' "the phase completed: $done; the output check passed: $output; keys typed in the phase: $($typed.Count), not 1"
    return
  }
  # The control: a key planted in one file of the data folder, in UTF-16, must be found.
  $plant = 'fk' + (Rand 24)
  $planted = Join-Path $data 'shell\planted-control.bin'
  [IO.File]::WriteAllBytes($planted, [Text.Encoding]::Unicode.GetBytes("x $plant x"))
  $control = Search-Keys @($data) $log @($plant)
  Remove-Item $planted -Force
  $real = Search-Keys @($data) $log @($typed)
  $ok = ($control.found -contains 'planted-control.bin') -and $control.unread.Count -eq 0 -and $real.unread.Count -eq 0 -and $real.found.Count -eq 0 -and $real.read -gt 10
  $detail = "after the run: $($real.read) of $($real.listed) files read under the data folder (WebView2's inside it) and the log, for the one key typed in the phase, in UTF-8 and UTF-16: $(if ($real.found.Count) { 'found in ' + ($real.found -join ' ') } else { 'none found' }); the planted control was $(if ($control.found -contains 'planted-control.bin') { 'found' } else { 'missed' })"
  if ($real.unread.Count -or $control.unread.Count) { $detail += "; unread: " + (@($real.unread + $control.unread) | Select-Object -First 5) -join ' | ' }
  Result $(if ($ok) { 'PASS' } else { 'FAIL' }) 'security.server.blank-search' $detail
}

function Run-ProcChecks {
  Write-Host '--- server, file, system and wake checks'
  Setup-Smb
  $env:FAMILIAR_CHECK_PARENT_ONLY = 'only-in-familiar'
  try {
    $data = Join-Path $tmp 'proc-data'
    $log = Join-Path $Out 'proc-main.log'
    $keysBefore = $script:keys.Count
    [void](Run-Phase 'proc-main' $log @('--app-dir', $App, '--data-dir', $data, '--log', $log, '--seconds', '900', '--phase', 'proc-main') 960)
    [void](No-Strays 'proc-main')
    Check-BlankSearch $data $log @($script:keys | Select-Object -Skip $keysBefore)

    # An unreadable approval store: every setup asks again.
    Set-Content (Join-Path $data 'shell\servers.json') 'not a store {'
    $log = Join-Path $Out 'proc-files.log'
    [void](Run-Phase 'proc-files' $log @('--app-dir', $App, '--data-dir', (Join-Path $tmp 'proc-files-data'), '--log', $log, '--seconds', '300', '--phase', 'proc-files') 330)
    [void](No-Strays 'proc-files')

    $log = Join-Path $Out 'proc-recover.log'
    [void](Run-Phase 'proc-recover' $log @('--app-dir', $App, '--data-dir', $data, '--log', $log, '--seconds', '120', '--phase', 'proc-recover') 150)
    [void](No-Strays 'proc-recover')

    $log = Join-Path $Out 'proc-race.log'
    [void](Run-Phase 'proc-race' $log @('--app-dir', $App, '--data-dir', (Join-Path $tmp 'proc-race-data'), '--log', $log, '--seconds', '400', '--phase', 'proc-race') 430)
    [void](No-Strays 'proc-race')

    $log = Join-Path $Out 'proc-stopped.log'
    [void](Run-Phase 'proc-stopped' $log @('--app-dir', $App, '--data-dir', (Join-Path $tmp 'proc-stopped-data'), '--log', $log, '--seconds', '240', '--phase', 'proc-stopped') 270)
    [void](No-Strays 'proc-stopped')

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
