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
  [DllImport("user32")] static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32")] static extern int GetMenuItemCount(IntPtr m);
  [DllImport("user32")] static extern uint GetMenuItemID(IntPtr m, int i);
  [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetMenuStringW(IntPtr m, uint item, StringBuilder s, int n, uint flags);
  /* The texts of an open popup menu's items, and the command id of the one whose text (access
     keys aside) is `want`, or -1. */
  public static long MenuItem(long menuWnd, string want, out string seen) {
    var hm = SendMessageW(new IntPtr(menuWnd), 0x01E1, IntPtr.Zero, IntPtr.Zero); /* MN_GETHMENU */
    var names = new System.Collections.Generic.List<string>(); long found = -1;
    int n = hm == IntPtr.Zero ? 0 : GetMenuItemCount(hm);
    for (int i = 0; i < n; i++) {
      var sb = new StringBuilder(256); GetMenuStringW(hm, (uint)i, sb, 256, 0x400); /* MF_BYPOSITION */
      var t = sb.ToString().Replace("&", ""); names.Add(t);
      if (t == want) found = GetMenuItemID(hm, i);
    }
    seen = string.Join(", ", names);
    return found;
  }
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

# A task dialog's button shows in UI Automation as a pane, CommandButton_<id>, named by its text.
function Dialog-Button($el, [string]$name) {
  return @($el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) |
    Where-Object { ($_.Current.Name -replace '&', '') -eq $name -and ($_.Current.AutomationId -like 'CommandButton_*' -or $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) } |
    Select-Object -First 1
}

# A real mouse click in the middle of an element. True if the input went in.
function Click-El($b) {
  if (-not $b) { return $false }
  $r = $b.Current.BoundingRectangle
  if ($r.IsEmpty) { return $false }
  return [W]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
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

# ---------- the fake server, keys typed, hosts and the proxy ----------
$script:keys = [System.Collections.Generic.List[string]]::new()
$script:netServer = $null
$script:certThumb = $null
$script:hostsBackup = $null
$script:proxyBackup = $null
$script:proxyFrom = 0
$hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$inet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

function Random-Text([int]$n) { -join ((1..$n) | ForEach-Object { 'abcdefghijkmnopqrstuvwxyz23456789'[(Get-Random -Maximum 33)] }) }

# The fake server, with a self-signed certificate the system doesn't trust, made for this run.
# The runner's own resolver is swapped for dns-server.mjs, which answers planned names and forwards
# the rest to the resolver the runner had. Put back by Stop-NetServer.
$script:dnsServer = $null
$script:dnsAdapter = $null
$script:dnsOriginal = $null
function Start-DnsServer {
  # The interface of the default route, and the resolver it had.
  $if = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1).InterfaceIndex
  $script:dnsOriginal = @((Get-DnsClientServerAddress -InterfaceIndex $if -AddressFamily IPv4 -ErrorAction Stop).ServerAddresses)
  if (-not $script:dnsOriginal.Count) { throw "interface $if has no IPv4 resolver" }
  $script:dnsAdapter = $if
  $upstream = $script:dnsOriginal[0]
  '{}' | Set-Content (Join-Path $Out 'dns-plan.json')
  $script:dnsServer = Start-Process node -ArgumentList "`"$(Join-Path $here 'dns-server.mjs')`"", "`"$Out`"", $upstream -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $Out 'dns-server.out') -RedirectStandardError (Join-Path $Out 'dns-server.err')
  for ($i = 0; $i -lt 50 -and -not (Select-String -Path (Join-Path $Out 'dns-server.out') -Pattern 'dns server up' -Quiet -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
  Set-DnsClientServerAddress -InterfaceIndex $if -ServerAddresses '127.0.0.1'
  Clear-DnsClientCache
  $script:lanIp = (Get-NetIPAddress -InterfaceIndex $if -AddressFamily IPv4 | Select-Object -First 1).IPAddress
  Write-Host "dns server on 127.0.0.1, forwarding to $upstream; the runner's lan address $($script:lanIp)"
}

function Stop-DnsServer {
  try {
    if ($script:dnsAdapter) { Set-DnsClientServerAddress -InterfaceIndex $script:dnsAdapter -ServerAddresses $script:dnsOriginal; Clear-DnsClientCache }
  } catch { Write-Host "dns: the resolver couldn't be put back: $_" }
  $script:dnsAdapter = $null
  if ($script:dnsServer -and -not $script:dnsServer.HasExited) { $script:dnsServer.Kill() }
}

function Dns-Log { @(Get-Content (Join-Path $Out 'dns-log.jsonl') | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }) }

function Start-NetServer {
  Start-DnsServer
  $cert = New-SelfSignedCertificate -DnsName 'localhost', '127.0.0.1' -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(1)
  $script:certThumb = $cert.Thumbprint
  $word = Random-Text 24
  $pfx = Join-Path $tmp 'net.pfx'
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString -String $word -Force -AsPlainText) | Out-Null
  $script:netServer = Start-Process node -ArgumentList "`"$(Join-Path $here 'net-server.mjs')`"", "`"$Out`"", "`"$App`"", "`"$pfx`"", $word, $script:lanIp -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $Out 'net-server.out') -RedirectStandardError (Join-Path $Out 'net-server.err')
  for ($i = 0; $i -lt 100 -and -not (Test-Path (Join-Path $App 'net.json')); $i++) { Start-Sleep -Milliseconds 100 }
  $script:net = Get-Content (Join-Path $App 'net.json') -Raw | ConvertFrom-Json
}

# Everything put back: hosts, the proxy, the certificate, the server.
function Stop-NetServer {
  if ($null -ne $script:hostsBackup) { Set-Content $hostsFile $script:hostsBackup; Clear-DnsClientCache }
  if ($null -ne $script:proxyBackup) { Restore-Proxy }
  if ($script:certThumb) { Remove-Item "Cert:\CurrentUser\My\$($script:certThumb)" -ErrorAction SilentlyContinue }
  if ($script:netServer -and -not $script:netServer.HasExited) { $script:netServer.Kill() }
  Stop-DnsServer
  if ($script:shellLocked) { & icacls $script:shellLocked /remove:d "$env:USERNAME" | Out-Null }
}

function Restore-Proxy {
  foreach ($k in 'ProxyEnable', 'ProxyServer', 'ProxyOverride') {
    $v = $script:proxyBackup[$k]
    if ($null -eq $v) { Remove-ItemProperty $inet -Name $k -ErrorAction SilentlyContinue } else { Set-ItemProperty $inet -Name $k -Value $v }
  }
  $script:proxyBackup = $null
}

# The system proxy setting as the registry has it: pac, manual, auto-detect or none.
function Proxy-Kind {
  $s = Get-ItemProperty $inet
  if ($s.AutoConfigURL) { return 'pac' }
  if ($s.ProxyEnable -eq 1 -and $s.ProxyServer) { return 'manual' }
  $b = (Get-ItemProperty "$inet\Connections" -ErrorAction SilentlyContinue).DefaultConnectionSettings
  if ($b -and $b.Length -gt 8 -and ($b[8] -band 0x08)) { return 'auto-detect' }
  return 'none'
}

function Net-Log { @(Get-Content (Join-Path $Out 'net-log.jsonl') | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }) }

# After the main run: no copy of any typed key in the data folder, the WebView2 folder or the log,
# in UTF-8 or UTF-16.
function Net-AfterMain([string]$data, [string]$log) {
  if ($script:keys.Count -eq 0) { Result 'FAIL' 'security.key.no-copy' 'no key was typed, so nothing was searched'; return }
  # A control key planted in each place searched, which the search must find: in the data folder,
  # deep in WebView2's folder, and in the log, as UTF-16 and as UTF-8.
  $control = 'fk' + (Random-Text 30)
  $webview = Join-Path $data 'webview'
  $deep = Get-ChildItem $webview -Recurse -Directory -Force -ErrorAction SilentlyContinue | Select-Object -Last 1
  $plants = [ordered]@{
    data = Join-Path $data 'control.bin'
    webview = Join-Path $(if ($deep) { $deep.FullName } else { $webview }) 'control.bin'
  }
  [IO.File]::WriteAllBytes($plants.data, [Text.Encoding]::Unicode.GetBytes("x $control x"))
  [IO.File]::WriteAllBytes($plants.webview, [Text.Encoding]::UTF8.GetBytes("x $control x"))
  Add-Content $log "control $control"
  $problems = @()
  try { $files = @(Get-ChildItem $data -Recurse -File -Force -ErrorAction Stop) + @(Get-Item $log -ErrorAction Stop) }
  catch { $problems += "a folder couldn't be listed: $($_.Exception.Message)"; $files = @() }
  $found = @(); $controls = @{}; $bytes = 0; $scanned = 0
  foreach ($f in $files) {
    try { $b = [IO.File]::ReadAllBytes($f.FullName) }
    catch { $problems += "unreadable: $($f.Name)"; continue }
    $scanned++
    $bytes += $b.Length
    $t8 = [Text.Encoding]::UTF8.GetString($b)
    $t16 = [Text.Encoding]::Unicode.GetString($b)
    $t16b = if ($b.Length -gt 1) { [Text.Encoding]::Unicode.GetString($b, 1, $b.Length - 1) } else { '' }
    $has = { param($k) $t8.Contains($k) -or $t16.Contains($k) -or $t16b.Contains($k) }
    foreach ($k in $script:keys) { if (& $has $k) { $found += $f.Name } }
    if (& $has $control) {
      $where = if ($f.FullName -eq (Get-Item $log).FullName) { 'log' } elseif ($f.FullName.StartsWith($webview)) { 'webview' } else { 'data' }
      $controls[$where] = $true
    }
  }
  foreach ($p in $plants.Values) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
  $missed = @('data', 'webview', 'log' | Where-Object { -not $controls[$_] })
  $ok = $problems.Count -eq 0 -and $missed.Count -eq 0 -and $found.Count -eq 0 -and $scanned -eq $files.Count -and $scanned -gt 10
  Result $(if ($ok) { 'PASS' } else { 'FAIL' }) 'security.key.no-copy' "$($script:keys.Count) keys searched for in $scanned of $($files.Count) files ($bytes bytes), UTF-8 and UTF-16; the planted control was found in $((@('data', 'webview', 'log' | Where-Object { $controls[$_] })) -join ', ')$(if ($missed.Count) { ', missed in ' + ($missed -join ', ') }); $(if ($found.Count) { 'a key was found in ' + ($found -join ' ') } else { 'no key found' })$(if ($problems.Count) { '; ' + ($problems -join '; ') })"
}

# After the capture: no lookup before Allow.
function Net-Lookups {
  $l = & node (Join-Path $here 'net-analyze.mjs') $Out
  $code = $LASTEXITCODE
  if ($code -eq 0 -and $l) { $results.Add([string]$l) } else { Result 'FAIL' 'security.fetch.no-lookup-before-allow' "the analysis failed: node exit $code" }
}

# Presses a dialog's button: through UI Automation by its name, or, if UI Automation doesn't show
# it, with TDM_CLICK_BUTTON and the exe's button id. Says which.
function Answer-Dialog($h, $el, [string]$name, [int]$id) {
  $b = Dialog-Button $el $name
  try { if ($b -and (Invoke-El $b)) { return 'ui automation' } } catch { }
  if (Click-El $b) {
    Start-Sleep -Milliseconds 400
    if (-not [WN]::Shown([uint32]$script:proc.Id, '#32770')) { return 'a click' }
  }
  [void][W]::Post($h, 0x466, $id, 0)
  return 'TDM_CLICK_BUTTON'
}

function Do-NetStep($action, $a) {
  switch ($action) {
    'type-key' {
      # A fake key, made here and never shown to a page, typed into Settings by real key presses.
      $key = 'fk' + (Random-Text $(if ($a.long) { 38 } else { 10 }))
      $script:keys.Add($key)
      $h = Bring-Front $a.title
      if (-not $h) { throw 'could not bring Settings to the front' }
      [System.Windows.Forms.SendKeys]::SendWait($key)
      Start-Sleep -Milliseconds 300
      $sha = ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("Bearer $key")))).ToLower()
      return @{ sha = $sha; head = $key.Substring(0, 10); tail = $key.Substring($key.Length - 10); length = $key.Length; last4 = $key.Substring($key.Length - 4) }
    }
    'cmdkey' {
      $list = (& cmdkey /list) -join "`n"
      return @{ found = $list.Contains($a.target) }
    }
    'hosts' {
      if ($null -eq $script:hostsBackup) { $script:hostsBackup = @(Get-Content $hostsFile) }
      $lines = @(Get-Content $hostsFile | Where-Object { $_ -notmatch "\s$([regex]::Escape($a.name))\s*$" })
      if ($a.ip) { $lines += "$($a.ip) $($a.name)" }
      Set-Content $hostsFile $lines
      Clear-DnsClientCache
      return @{}
    }
    'proxy' {
      if ($a.on) {
        $cur = Get-ItemProperty $inet
        $script:proxyBackup = @{ ProxyEnable = $cur.ProxyEnable; ProxyServer = $cur.ProxyServer; ProxyOverride = $cur.ProxyOverride }
        $script:proxyFrom = (Net-Log).Count
        Set-ItemProperty $inet -Name ProxyEnable -Value 1 -Type DWord
        Set-ItemProperty $inet -Name ProxyServer -Value "127.0.0.1:$($script:net.proxy)"
        Set-ItemProperty $inet -Name ProxyOverride -Value ''
        return @{}
      }
      Restore-Proxy
      $seen = @(Net-Log | Select-Object -Skip $script:proxyFrom | Where-Object { $_.proxy })
      return @{ targets = @($seen | ForEach-Object { $_.target }); entries = @($seen | ForEach-Object { @{ target = $_.target; at = $_.at } }) }
    }
    'proxy-kind' { return @{ kind = (Proxy-Kind) } }
    'net-requests' {
      $since = if ($a.since) { [long]$a.since } else { 0 }
      return @{ count = @(Net-Log | Where-Object { $_.path -and $_.path.StartsWith($a.path) -and $_.at -ge $since }).Count }
    }
    'dns-plan' {
      $f = Join-Path $Out 'dns-plan.json'
      $plan = Get-Content $f -Raw | ConvertFrom-Json -AsHashtable
      $plan[$a.name] = @{ answers = @($a.answers | ForEach-Object { , @($_) }); delay = @($a.delay) }
      $plan | ConvertTo-Json -Depth 6 | Set-Content $f
      Clear-DnsClientCache
      return @{ lanIp = $script:lanIp }
    }
    'dns-queries' {
      $q = @(Dns-Log | Where-Object { $_.name -eq $a.name -and $_.type -eq 1 })
      return @{ count = $q.Count; queries = @($q | ForEach-Object { @{ at = $_.at; n = $_.n; answered = ($_.answered -join ',') } }) }
    }
    'dns-canary' {
      $name = "$($a.label).familiar-check.test"
      Clear-DnsClientCache
      if ($a.tcp) { Resolve-DnsName $name -DnsOnly -TcpOnly -QuickTimeout -ErrorAction SilentlyContinue | Out-Null }
      else { Resolve-DnsName $name -DnsOnly -QuickTimeout -ErrorAction SilentlyContinue | Out-Null }
      return @{ at = (Now-Ms) }
    }
    'conns' {
      $since = if ($a.since) { [long]$a.since } else { 0 }
      return @{ count = @(Net-Log | Where-Object { $_.conn -eq $a.kind -and $_.at -ge $since }).Count }
    }
    'shell-lock' {
      $dir = Join-Path $a.data 'shell'
      if ($a.on) {
        & icacls $dir /deny "$($env:USERNAME):(W,AD,WD,DC)" | Out-Null
        $script:shellLocked = $dir
      } else {
        & icacls $dir /remove:d "$env:USERNAME" | Out-Null
        $script:shellLocked = $null
      }
      return @{ code = $LASTEXITCODE }
    }
    'net-open' {
      $c = [Net.Sockets.TcpClient]::new('127.0.0.1', [int]$script:net.control)
      $r = [IO.StreamReader]::new($c.GetStream()).ReadToEnd()
      $c.Close()
      return ($r | ConvertFrom-Json)
    }
    'dialog' {
      $res = [ordered]@{ tree = @(); found = $false; title = ''; texts = @(); details = ''; buttons = @(); approveAtStart = $false; approveLater = $false; invokedEarly = ''; owner = ''; topmost = $false; answered = '' }
      $wait = if ($a.act -eq 'none') { 2500 } else { 15000 }
      $h = Wait-Dialog $wait
      if (-not $h) { return $res }
      $res.found = $true
      $script:shotN++
      Write-Host "dialog $($a.act): found $h"
      if (-not [WN]::Responds($h)) {
        Screen-Shot "dialog-$($script:shotN)-hung"
        $res.answered = 'the dialog does not respond'
        return $res
      }
      $el = $UIA::FromHandle([IntPtr]$h)
      $approve = Dialog-Button $el $a.approve
      $res.approveAtStart = [bool]($approve -and $approve.Current.IsEnabled)
      if ($a.act -eq 'enter') {
        # The approve button sampled every 40 ms from the dialog's creation, which the exe logs
        # with its wall-clock time, and one real click on it 300 ms in, which must do nothing.
        $m = Select-String -Path $script:log -Pattern 'confirm: dialog shown at (\d+)' | Select-Object -Last 1
        $created = if ($m) { [long]$m.Matches[0].Groups[1].Value } else { 0 }
        $samples = [System.Collections.Generic.List[object]]::new()
        # Where to click, read before sampling starts. The click (a cursor move and a press, with
        # pauses) runs on a thread of its own so the sampling goes on through it.
        $r = $approve.Current.BoundingRectangle
        $clicked = $false
        $clickJob = $null
        while ($created -and (Now-Ms) - $created -lt 1600) {
          $t = (Now-Ms) - $created
          try { $samples.Add(@{ t = $t; on = [bool]$approve.Current.IsEnabled }) } catch { break }
          if (-not $clicked -and $t -ge 300) {
            $clicked = $true
            if ($r.IsEmpty) { $res.invokedEarly = 'could not click' }
            else { $clickJob = Start-ThreadJob -ScriptBlock { param($x, $y) [W]::Click($x, $y) } -ArgumentList ([int]($r.X + $r.Width / 2)), ([int]($r.Y + $r.Height / 2)) }
            continue
          }
          Start-Sleep -Milliseconds 40
        }
        if ($clickJob) {
          $went = [bool](Receive-Job $clickJob -Wait -AutoRemoveJob)
          $res.invokedEarly = if ($went) { 'clicked' } else { 'could not click' }
        }
        # The dialog still showing after the early click means the click did nothing.
        if ($res.invokedEarly -eq 'clicked') { $res.invokedEarly = if ([WN]::Shown([uint32]$script:proc.Id, '#32770')) { 'no effect' } else { 'closed it' } }
        $on = @($samples | Where-Object { $_.on })
        $off = @($samples | Where-Object { -not $_.on })
        $gaps = @(for ($i = 1; $i -lt $samples.Count; $i++) { $samples[$i].t - $samples[$i - 1].t })
        # When the exe's own timer enabled the button, from the dialog's creation.
        $en = $null
        for ($i = 0; $i -lt 20 -and -not $en; $i++) {
          $en = Select-String -Path $script:log -Pattern 'confirm: approve enabled (\d+) ms after creation' | Select-Object -Last 1
          if (-not $en) { Start-Sleep -Milliseconds 100 }
        }
        $res.timing = [ordered]@{
          enabledAt = $(if ($en) { [long]$en.Matches[0].Groups[1].Value } else { -1 })
          created = $created
          firstSample = $(if ($samples.Count) { $samples[0].t } else { -1 })
          lastOff = $(if ($off.Count) { $off[-1].t } else { -1 })
          firstOn = $(if ($on.Count) { $on[0].t } else { -1 })
          samples = $samples.Count
          maxGap = $(if ($gaps.Count) { ($gaps | Measure-Object -Maximum).Maximum } else { -1 })
        }
      } else {
        Start-Sleep -Milliseconds 1300
      }
      # What UI Automation sees of the dialog, for the results.
      $res.owner = [WN]::OwnerTitle($h)
      $res.topmost = [WN]::Topmost($h)
      if ($res.invokedEarly -ne 'closed it') {
        $res.tree = @($el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Select-Object -First 60 | ForEach-Object { "$($_.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''):$($_.Current.Name):$($_.Current.AutomationId)" })
        if ($script:shotN -le 2) { Write-Host "dialog tree: $($res.tree -join ' | ')" }
      }
      if ($res.invokedEarly -ne 'closed it') {
        $approve = Dialog-Button $el $a.approve
        $res.approveLater = [bool]($approve -and $approve.Current.IsEnabled)
        $res.texts = Dialog-Texts $el
        $res.buttons = @(Uia-All $el ([System.Windows.Automation.ControlType]::Button) | ForEach-Object { @{ name = $_.Current.Name; enabled = $_.Current.IsEnabled } })
        if ($a.details) {
          $more = Dialog-Button $el 'Show details'
          if ($more) { [void](Invoke-El $more); Start-Sleep -Milliseconds 400 }
          $after = Dialog-Texts $el
          $res.details = (@($after | Where-Object { $res.texts -notcontains $_ }) -join "`n")
        }
      }
      if ($script:shotN -le 3) { Screen-Shot "dialog-$($script:shotN)" }
      switch ($a.act) {
        'approve' { $res.answeredAt = Now-Ms; $res.answered = Answer-Dialog $h $el $a.approve 100 }
        'refuse' { $res.answered = Answer-Dialog $h $el $a.refuse 101 }
        'close' { [void][W]::Post($h, 0x10, 0, 0); $res.answered = 'closed' }
        'enter' {
          [void][W]::Foreground($h)
          Start-Sleep -Milliseconds 300
          [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
          $res.answered = 'enter'
        }
        default { $res.answered = 'held' }
      }
      return $res
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
      for ($i = 0; $i -lt 50 -and -not $menu; $i++) { Start-Sleep -Milliseconds 100; $menu = [WN]::Shown([uint32]$script:proc.Id, '#32768') }
      if (-not $menu) { return @{ done = $false; how = 'no menu appeared' } }
      Start-Sleep -Milliseconds 300
      # The item's command id, read from the open menu, sent to the tray's window as the menu
      # itself sends it when the item is picked; then the menu is closed.
      $seen = ''
      $id = [WN]::MenuItem($menu, 'Let Familiar ask again', [ref]$seen)
      if ($id -lt 0) {
        [void][W]::Post($h, 0x1F, 0, 0)
        return @{ done = $false; how = "the menu has no such item: $seen" }
      }
      [void][W]::Post($h, 0x111, $id, 0)
      Start-Sleep -Milliseconds 200
      [void][W]::Post($h, 0x1F, 0, 0)
      $how = "picked from the tray menu ($seen) by its command"
      Start-Sleep -Milliseconds 500
      return @{ done = -not [WN]::Shown([uint32]$script:proc.Id, '#32768'); how = $how }
    }
    default { return $null }
  }
}
