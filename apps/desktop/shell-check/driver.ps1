# The contract check's other half, for the Actions Windows runner only. It starts familiar.exe on
# the check app folder once per phase, and does what a page can't when a page asks (`STEP n action
# args` in the log): a second launch, a tray click, the clipboard, keystrokes, a look at the
# windows, the log and the listeners. Around the runs it keeps the egress fixtures: listeners on
# 127.0.0.1 with a STUN responder, a pktmon capture of DNS, mDNS, LLMNR and a LAN address, the DNS
# Client log, and the positive controls. Results go to <Out>/contract.txt as `PASS|FAIL|SKIP id
# detail`, for gate.mjs.
param(
  [Parameter(Mandatory)][string]$Exe,
  [Parameter(Mandatory)][string]$App,
  [Parameter(Mandatory)][string]$Broken,
  [string]$Out = 'results'
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$Exe = (Resolve-Path $Exe).Path
$App = (Resolve-Path $App).Path
$Broken = (Resolve-Path $Broken).Path
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
. (Join-Path $here 'win32.ps1')
Add-Type -AssemblyName System.Windows.Forms

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('familiar-check-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
$results = [System.Collections.Generic.List[string]]::new()
$marks = [ordered]@{}
$script:log = $null
$script:proc = $null
function Result($state, $id, $detail) { $line = "$state $id $detail"; $results.Add($line); Write-Host $line }
function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Rand([int]$n) { -join ((1..$n) | ForEach-Object { 'abcdefghijklmnopqrstuvwxyz0123456789'[(Get-Random -Maximum 36)] }) }
function Quote([string]$a) { if ($a -eq '' -or $a -match '[\s"]') { '"' + ($a -replace '"', '\"') + '"' } else { $a } }

# The handle has to be held from the start, or ExitCode comes back empty.
function Launch([string]$file, [string[]]$argv) {
  $p = Start-Process -FilePath $file -ArgumentList (($argv | ForEach-Object { Quote $_ }) -join ' ') -PassThru
  [void]$p.Handle
  return $p
}

# Everything of ours still running: the exe, and WebView2 processes on a folder of this run.
function Ours {
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  @(Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq 'familiar.exe' -or ($_.Name -eq 'msedgewebview2.exe' -and ($_.CommandLine -like "*$tmp*" -or $_.CommandLine -like "*$local\dev.exvanitas.familiar*"))
    })
}

function Log-Lines {
  if (-not $script:log -or -not (Test-Path $script:log)) { return @() }
  $s = [IO.File]::Open($script:log, 'Open', 'Read', 'ReadWrite,Delete')
  try { $text = [IO.StreamReader]::new($s).ReadToEnd() } finally { $s.Close() }
  return $text.Split("`n")
}

function Sink-Count {
  $n = 0
  foreach ($l in Log-Lines) { if ($l -match 'sink refused (\d+) ') { $n = [int]$Matches[1] } }
  return $n
}

# A window of ours to the front, by title, clicking into it if asking isn't enough. Its handle, or 0.
function Bring-Front([string]$title) {
  $h = [W]::FindByTitle($title)
  if (-not $h) { return 0 }
  [void][W]::Foreground($h)
  Start-Sleep -Milliseconds 400
  if ([W]::CurrentForeground() -ne $h) {
    $r = [W]::Rect($h)
    [void][W]::Click([int](($r.L + $r.R) / 2), [int](($r.T + $r.B) / 2))
    Start-Sleep -Milliseconds 300
  }
  if ([W]::CurrentForeground() -ne $h) { return 0 }
  return $h
}

function Do-Step($action, $a) {
  switch ($action) {
    'second-launch' {
      $t = [Diagnostics.Stopwatch]::StartNew()
      $p = Launch $Exe @($a.args)
      if (-not $p.WaitForExit(15000)) { $p.Kill(); throw 'the second launch did not exit' }
      return @{ exit = $p.ExitCode; ms = $t.ElapsedMilliseconds }
    }
    'tray-click' {
      # What the shell sends the tray icon's window on a click: its callback message with the mouse
      # message in lParam. tray-icon's callback is WM_USER_TRAYICON, 6002.
      $h = [W]::FindClass([uint32]$script:proc.Id, 'tray_icon_app')
      if (-not $h) { return @{ done = $false; how = 'no tray window found' } }
      $down = [W]::Post($h, 6002, 0, 0x201)
      Start-Sleep -Milliseconds 60
      $up = [W]::Post($h, 6002, 0, 0x202)
      return @{ done = ($down -and $up); how = 'posted the tray callback message' }
    }
    'clipboard-set' { Set-Clipboard -Value $a.text; return @{} }
    'clipboard-get' { return @{ text = [string](Get-Clipboard -Raw) } }
    'windows' {
      $pids = @(Ours | ForEach-Object { [uint32]$_.ProcessId })
      return @{ windows = @([W]::Visible($pids)) }
    }
    'log-grep' {
      $hits = @(Log-Lines | Where-Object { $_ -match $a.pattern } | ForEach-Object { $_.Trim() })
      return @{ count = $hits.Count; lines = @($hits | Select-Object -First 60) }
    }
    'focus' {
      $h = Bring-Front $a.title
      return @{ focused = [bool]$h }
    }
    'paste' {
      $h = Bring-Front $a.title
      if (-not $h) { return @{ sent = $false; why = 'could not bring the window to the front' } }
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Start-Sleep -Milliseconds 300
      return @{ sent = $true }
    }
    'click' {
      $h = [W]::FindByTitle($a.title)
      if (-not $h) { return @{ clicked = $false; why = 'no window titled so' } }
      [void][W]::Foreground($h)
      Start-Sleep -Milliseconds 300
      $r = [W]::Rect($h)
      $ok = [W]::Click([int](($r.L + $r.R) / 2), [int](($r.T + $r.B) / 2 + 10))
      return @{ clicked = $ok; why = $(if ($ok) { '' } else { 'SendInput refused: no interactive desktop' }) }
    }
    'mark' {
      $m = @{ at = (Now-Ms); sink = (Sink-Count) }
      $marks[$a.name] = $m
      return $m
    }
    'hits' {
      $n = 0
      foreach ($l in Get-Content (Join-Path $Out 'hits.jsonl')) {
        if (-not $l) { continue }
        $h = $l | ConvertFrom-Json
        if ($h.label -and $h.label.StartsWith($a.prefix) -and (@('c', 'v', 'b') -contains $h.label.Substring($a.prefix.Length, 1))) { $n++ }
        if (($h.kind -eq 'udp' -or $h.kind -eq 'tcp') -and $h.listener -match '^(core|view|bare)-') { $n++ }
      }
      return @{ hits = $n }
    }
    default { throw "unknown step $action" }
  }
}

function Answer($n, $value) {
  $dir = Join-Path $App 'driver'
  New-Item -ItemType Directory -Force $dir | Out-Null
  $temp = Join-Path $dir ".~$n"
  [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 6 -Compress))
  Move-Item -Force $temp (Join-Path $dir "$n.json")
}

function Handle([string]$raw) {
  $line = $raw.TrimEnd()
  if ($line -match '^\s*[\d.]+ core not ready$') { $script:notReady = $true }
  if ($line -match '^\s*[\d.]+ \[[a-z0-9-]+\] CHECK (PASS|FAIL|SKIP) (\S+) ?(.*)$') { Result $Matches[1] $Matches[2] $Matches[3] }
  elseif ($line -match '^\s*[\d.]+ \[[a-z0-9-]+\] STEP (\d+) (\S+) (.*)$') {
    $n = $Matches[1]; $action = $Matches[2]; $json = $Matches[3]
    try { Answer $n (Do-Step $action ($json | ConvertFrom-Json)) }
    catch { Write-Host "step $action failed: $_"; Answer $n @{ error = "$_" } }
  }
}

# One run of the exe, reading its log as it goes. Returns the process.
function Run-Phase([string]$name, [string]$log, [string[]]$argv, [int]$limit, [string]$exe = $Exe) {
  Write-Host "--- phase $name"
  $script:log = $log
  Remove-Item $log -ErrorAction SilentlyContinue
  $offset = 0
  $p = Launch $exe $argv
  $script:proc = $p
  $deadline = [DateTime]::Now.AddSeconds($limit)
  $pending = ''
  $script:notReady = $false
  while ($true) {
    $exited = $p.HasExited
    if (Test-Path $log) {
      $s = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite,Delete')
      try { [void]$s.Seek($offset, 'Begin'); $bytes = [byte[]]::new($s.Length - $offset); $read = $s.Read($bytes, 0, $bytes.Length) } finally { $s.Close() }
      $offset += $read
      $pending += [Text.Encoding]::UTF8.GetString($bytes, 0, $read)
      $end = $pending.LastIndexOf("`n")
      if ($end -ge 0) {
        foreach ($l in $pending.Substring(0, $end).Split("`n")) { Handle $l }
        $pending = $pending.Substring($end + 1)
      }
    }
    if ($exited) { break }
    if ($script:notReady -and $name -ne 'not-ready') { Result 'FAIL' 'check.phase' "${name}: core never said ready"; $p.Kill(); break }
    if ([DateTime]::Now -gt $deadline) { Result 'FAIL' 'check.phase' "$name still running after $limit s"; $p.Kill(); break }
    Start-Sleep -Milliseconds 50
  }
  if ($pending) { Handle $pending }
  [void]$p.WaitForExit(5000)
  return $p
}

function Quit-Ms([string]$log) {
  $m = Select-String -Path $log -Pattern 'quit: done after (\d+) ms' | Select-Object -Last 1
  if ($m) { return [int]$m.Matches[0].Groups[1].Value } else { return -1 }
}

function No-Strays([string]$after) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  do {
    $strays = Ours
    if ($strays.Count) { Start-Sleep -Milliseconds 500 }
  } while ($strays.Count -and $t.Elapsed.TotalSeconds -lt 15)
  Result $(if ($strays.Count -eq 0) { 'PASS' } else { 'FAIL' }) 'check.exit.no-strays' "after $after, $($strays.Count) left after $($t.ElapsedMilliseconds) ms"
  foreach ($s in $strays) { Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue }
  return $strays.Count -eq 0
}

$fixtures = $null
$capturing = $false
$quitParts = [ordered]@{}
try {
  # ---------- the fixtures and the capture ----------
  $fixtures = Start-Process node -ArgumentList "`"$(Join-Path $here 'fixtures.mjs')`"", "`"$Out`"", "`"$App`"" -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $Out 'fixtures.out') -RedirectStandardError (Join-Path $Out 'fixtures.err')
  for ($i = 0; $i -lt 100 -and -not (Test-Path (Join-Path $App 'fixtures.json')); $i++) { Start-Sleep -Milliseconds 100 }
  $fx = Get-Content (Join-Path $App 'fixtures.json') -Raw | ConvertFrom-Json
  Write-Host "fixtures: run $($fx.run) http $($fx.tcp)"

  & wevtutil sl Microsoft-Windows-DNS-Client/Operational /e:true
  & wevtutil cl Microsoft-Windows-DNS-Client/Operational
  & pktmon stop 2>&1 | Out-Null
  & pktmon filter remove 2>&1 | Out-Null
  & pktmon filter add dns -p 53 | Out-Host
  & pktmon filter add mdns -p 5353 | Out-Host
  & pktmon filter add llmnr -p 5355 | Out-Host
  & pktmon filter add lan -i $fx.lan | Out-Host
  $etl = Join-Path $tmp 'capture.etl'
  & pktmon start --capture --pkt-size 0 --file-name $etl | Out-Host
  $capturing = ($LASTEXITCODE -eq 0)
  Write-Host "pktmon capturing: $capturing"

  # ---------- the main run ----------
  $data = Join-Path $tmp 'data'
  $main = Join-Path $Out 'check.log'
  $p = Run-Phase 'main' $main @('--app-dir', $App, '--data-dir', $data, '--log', $main, '--seconds', '600', '--phase', 'main') 660
  $mainMs = Quit-Ms $main
  $mainWrite = [bool](Select-String -Path $main -Pattern 'INFO quit write finished' -Quiet)
  $quitParts.main = ($p.ExitCode -eq 0 -and $mainMs -ge 0 -and $mainMs -lt 3000 -and $mainWrite)
  Write-Host "main: exit $($p.ExitCode), quit after $mainMs ms, write while quitting $mainWrite"
  $quitParts.strays = No-Strays 'the main run'
  $urls = @(Select-String -Path $main -Pattern '(navigation|new window) refused' | Where-Object { $_.Line -match '://' })
  if ($urls.Count) { Result 'FAIL' 'security.nav.refused' "$($urls.Count) refusal lines carry a URL" }

  # ---------- the pins, on the default data folder ----------
  $pinned = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'dev.exvanitas.familiar'
  Remove-Item $pinned -Recurse -Force -ErrorAction SilentlyContinue
  $value = Rand 24
  $log = Join-Path $Out 'pin-write.log'
  $p = Run-Phase 'pin-write' $log @('--app-dir', $App, '--log', $log, '--seconds', '120', '--phase', 'pin-write', '--value', $value) 150
  $writeMs = Quit-Ms $log
  $quitParts.pinWrite = ($p.ExitCode -eq 0 -and $writeMs -ge 0 -and $writeMs -lt 3000 -and [bool](Select-String -Path $log -Pattern 'INFO quit write finished' -Quiet))
  [void](No-Strays 'pin-write')
  $leveldb = Join-Path $pinned 'webview\EBWebView\Default\IndexedDB\http_tauri.localhost_0.indexeddb.leveldb'
  $files = @(Get-ChildItem $leveldb -ErrorAction SilentlyContinue).Count
  Result $(if ((Test-Path $leveldb) -and $files) { 'PASS' } else { 'FAIL' }) 'security.pin.folder' "%LOCALAPPDATA%\dev.exvanitas.familiar\webview\EBWebView\Default\IndexedDB\http_tauri.localhost_0.indexeddb.leveldb exists: $(Test-Path $leveldb), $files files"

  $log = Join-Path $Out 'pin-read.log'
  $p = Run-Phase 'pin-read' $log @('--app-dir', $App, '--log', $log, '--seconds', '120', '--phase', 'pin-read', '--value', $value) 150
  [void](No-Strays 'pin-read')

  # An install in another place: a copy of the exe with its app folder beside it, no --app-dir.
  $moved = Join-Path $tmp 'moved\Familiar'
  New-Item -ItemType Directory -Force $moved | Out-Null
  Copy-Item $Exe (Join-Path $moved 'familiar.exe')
  Copy-Item $App (Join-Path $moved 'app') -Recurse
  $log = Join-Path $Out 'pin-moved.log'
  $p = Run-Phase 'pin-moved' $log @('--log', $log, '--seconds', '120', '--phase', 'pin-moved', '--value', $value) 150 (Join-Path $moved 'familiar.exe')
  [void](No-Strays 'pin-moved')

  # A core that never answers `quitting`: the run still ends, 3 s later.
  $log = Join-Path $Out 'hung.log'
  $p = Run-Phase 'hung-quit' $log @('--app-dir', $App, '--data-dir', (Join-Path $tmp 'hung-data'), '--log', $log, '--seconds', '12', '--phase', 'hung-quit') 60
  $hungMs = Quit-Ms $log
  $quitParts.hung = ($p.ExitCode -eq 0 -and $hungMs -ge 2900 -and $hungMs -le 4500)
  Result $(if ($quitParts.hung) { 'PASS' } else { 'FAIL' }) 'check.quit.hung' "exit $($p.ExitCode), quit took $hungMs ms with core silent"
  [void](No-Strays 'hung-quit')

  $landed = [bool]($results | Where-Object { $_ -like 'PASS check.quit.write-landed*' })
  $ok = $quitParts.main -and $quitParts.pinWrite -and $quitParts.hung -and $quitParts.strays -and $landed
  Result $(if ($ok) { 'PASS' } else { 'FAIL' }) 'security.quit.clean' "main exit 0 and done in $mainMs ms with its quitting write: $($quitParts.main); pin-write $writeMs ms: $($quitParts.pinWrite); that write read back: $landed; silent core ended in $hungMs ms: $($quitParts.hung); no strays: $($quitParts.strays)"

  # ---------- a missing app folder: a box, and out with 1 ----------
  $log = Join-Path $Out 'no-app.log'
  $script:log = $log
  $p = Launch $Exe @('--app-dir', (Join-Path $tmp 'no-such-folder'), '--data-dir', (Join-Path $tmp 'none-data'), '--log', $log)
  $h = 0
  for ($i = 0; $i -lt 150 -and -not $h; $i++) { Start-Sleep -Milliseconds 100; $h = [W]::Dialog([uint32]$p.Id) }
  $text = if ($h) { [W]::DialogText($h) } else { '' }
  if ($h) { [W]::Press($h, 1) }
  if ($p.WaitForExit(10000)) {
    $said = [bool](Select-String -Path $log -Pattern 'app folder missing' -Quiet)
    $ok = $h -and $said -and $p.ExitCode -eq 1 -and $text -match 'app folder is missing'
    Result $(if ($ok) { 'PASS' } else { 'FAIL' }) 'check.start.no-app' "box $([bool]$h) text $($text -match 'app folder is missing') log $said exit $($p.ExitCode)"
  } else { Result 'FAIL' 'check.start.no-app' 'still running'; $p.Kill() }

  # ---------- a core page that throws: one box within 35 s, the tray stays ----------
  $log = Join-Path $Out 'not-ready.log'
  $script:log = $log
  $t = [Diagnostics.Stopwatch]::StartNew()
  $p = Launch $Exe @('--app-dir', $Broken, '--data-dir', (Join-Path $tmp 'broken-data'), '--log', $log, '--seconds', '50')
  $h = 0
  while (-not $h -and $t.Elapsed.TotalSeconds -lt 40 -and -not $p.HasExited) { Start-Sleep -Milliseconds 200; $h = [W]::Dialog([uint32]$p.Id) }
  $boxAt = $t.ElapsedMilliseconds
  $text = if ($h) { [W]::DialogText($h) } else { '' }
  if ($h) { [W]::Press($h, 1) }
  Start-Sleep -Seconds 2
  $stayed = -not $p.HasExited
  $tray = $stayed -and [bool]([W]::FindClass([uint32]$p.Id, 'tray_icon_app'))
  $exited = $p.WaitForExit(30000)
  $said = [bool](Select-String -Path $log -Pattern 'core not ready' -Quiet)
  $ok = $h -and $boxAt -le 35000 -and $stayed -and $tray -and $said -and $exited -and $p.ExitCode -eq 0 -and $text -match 'log'
  Result $(if ($ok) { 'PASS' } else { 'FAIL' }) 'check.start.not-ready' "box after $boxAt ms, names the log $($text -match 'log'), exe stayed $stayed with tray $tray, log $said, ended by --seconds $exited code $(if ($exited) { $p.ExitCode } else { '-' })"
  if (-not $exited) { $p.Kill() }
  [void](No-Strays 'not-ready')

  # ---------- the positive controls ----------
  Write-Host '--- controls'
  $dl = "$($fx.run)d00"; $dn = "$($fx.run)d01"
  try { Invoke-WebRequest "http://127.0.0.1:$($fx.tcp)/h/$dl/loop" -UseBasicParsing -TimeoutSec 5 | Out-Null } catch { Write-Host "control http: $_" }
  $u = [Net.Sockets.UdpClient]::new()
  $u.Client.ReceiveTimeout = 3000
  $stun = [byte[]](0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42) + [byte[]](1..12)
  [void]$u.Send($stun, $stun.Length, '127.0.0.1', [int]$fx.udp.'driver-stun')
  try { $ep = [Net.IPEndPoint]::new([Net.IPAddress]::Any, 0); $back = $u.Receive([ref]$ep); Write-Host "control stun answered $($back.Length) bytes" } catch { Write-Host 'control stun: no answer' }
  [void]$u.Send([byte[]](1, 2, 3), 3, '127.0.0.1', [int]$fx.udp.'driver-turn')
  [void]$u.Send([byte[]](1, 2, 3), 3, $fx.lan, 20499)
  $u.Close()
  try { $c = [Net.Sockets.TcpClient]::new('127.0.0.1', [int]$fx.turnTcp.driver); $c.Close() } catch { Write-Host "control tcp: $_" }
  Resolve-DnsName "$dn.familiar-check.test" -DnsOnly -QuickTimeout -ErrorAction SilentlyContinue | Out-Null
  Clear-DnsClientCache

  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($edge) {
    $edgeProfile = Join-Path $tmp 'edge-profile'
    $e = Start-Process $edge -ArgumentList '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', "--user-data-dir=`"$edgeProfile`"", "http://127.0.0.1:$($fx.tcp)/edge.html" -PassThru
    for ($i = 0; $i -lt 900 -and -not (Test-Path (Join-Path $Out 'edge-result.json')); $i++) { Start-Sleep -Milliseconds 100 }
    Start-Sleep -Seconds 3
    Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like "*$edgeProfile*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "edge control result: $(Test-Path (Join-Path $Out 'edge-result.json'))"
  } else { Write-Host 'no Edge found for the control' }
  Start-Sleep -Seconds 2
}
catch { Result 'FAIL' 'check.phase' "driver: $_ at line $($_.InvocationInfo.ScriptLineNumber)" }
finally {
  if ($capturing) {
    & pktmon stop | Out-Host
    & pktmon etl2pcap $etl --out (Join-Path $Out 'capture.pcapng') | Out-Host
    & pktmon filter remove | Out-Null
  }
  try {
    Get-WinEvent -LogName 'Microsoft-Windows-DNS-Client/Operational' -ErrorAction SilentlyContinue | ForEach-Object { $_.Message -replace "`r?`n", ' ' } | Set-Content (Join-Path $Out 'dns-log.txt')
  } catch { Write-Host "dns log: $_" }
  & wevtutil sl Microsoft-Windows-DNS-Client/Operational /e:false
  $marks | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Out 'marks.json')
  if ($fixtures -and -not $fixtures.HasExited) { $fixtures.Kill() }
  Get-Process familiar -ErrorAction SilentlyContinue | Stop-Process -Force
}

# ---------- the egress verdicts ----------
& node (Join-Path $here 'analyze.mjs') $Out | Out-Host
if (Test-Path (Join-Path $Out 'egress.txt')) { foreach ($l in Get-Content (Join-Path $Out 'egress.txt')) { if ($l) { $results.Add($l) } } }
else { Result 'FAIL' 'security.egress.controls' 'the analysis did not run' }
if ($env:GITHUB_STEP_SUMMARY -and (Test-Path (Join-Path $Out 'egress.md'))) { Get-Content (Join-Path $Out 'egress.md') | Add-Content $env:GITHUB_STEP_SUMMARY }

$results | Set-Content (Join-Path $Out 'contract.txt')
$pass = @($results | Where-Object { $_ -like 'PASS *' }).Count
$fail = @($results | Where-Object { $_ -like 'FAIL *' })
$skip = @($results | Where-Object { $_ -like 'SKIP *' })
Write-Host "contract check: $pass passed, $($fail.Count) failed, $($skip.Count) skipped"
exit 0
