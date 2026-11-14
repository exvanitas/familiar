# The smoke run: the real app folder with a fresh data folder. Core starts, says ready, opens chat,
# and the run ends cleanly at its time limit. Judged from the log. Runner only.
param(
  [Parameter(Mandatory)][string]$Exe,
  [Parameter(Mandatory)][string]$App,
  [string]$Out = 'results'
)
$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path $Exe).Path
$App = (Resolve-Path $App).Path
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$data = Join-Path ([IO.Path]::GetTempPath()) ('familiar-smoke-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
$log = Join-Path $Out 'smoke.log'
$results = [System.Collections.Generic.List[string]]::new()
function Result($state, $id, $detail) { $line = "$state $id $detail"; $results.Add($line); Write-Host $line }

$p = Start-Process -FilePath $Exe -ArgumentList '--app-dir', "`"$App`"", '--data-dir', "`"$data`"", '--log', "`"$log`"", '--seconds', '20' -PassThru
[void]$p.Handle
$ended = $p.WaitForExit(60000)
if (-not $ended) { $p.Kill() }
$text = if (Test-Path $log) { Get-Content -Raw $log } else { '' }
Result $(if ($text -match 'core ready') { 'PASS' } else { 'FAIL' }) 'check.smoke.ready' 'core said ready'
Result $(if ($text -match 'opened view-chat with chat\.html' -and $text -match '\[view-chat\] chat up') { 'PASS' } else { 'FAIL' }) 'check.smoke.chat' 'chat opened and its page ran'
$ms = if ($text -match 'quit: done after (\d+) ms') { [int]$Matches[1] } else { -1 }
$clean = $ended -and $p.ExitCode -eq 0 -and $ms -ge 0 -and $ms -lt 3000 -and $text -notmatch 'error '
Result $(if ($clean) { 'PASS' } else { 'FAIL' }) 'check.smoke.quit' "ended $ended, exit $(if ($ended) { $p.ExitCode } else { '-' }), quit in $ms ms, persist line: $(([regex]'persist granted=\S+ persisted=\S+').Match($text).Value)"
$results | Set-Content (Join-Path $Out 'smoke.txt')
exit 0
