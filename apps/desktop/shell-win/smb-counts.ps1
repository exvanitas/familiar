# The SMB counts the shell-win workflow decides on, sampled one way for the walk and its control:
# the SMB server's open count and the set of SMB client connections. A sample that can't be
# taken throws, so a verdict can never pass without a measurement.
$ErrorActionPreference = 'Stop'

function Get-SmbOpens {
    $s = @((Get-Counter -Counter '\Server\Files Opened Total' -ErrorAction Stop).CounterSamples)
    if ($s.Count -ne 1 -or $null -eq $s[0].CookedValue) { throw 'No sample of \Server\Files Opened Total' }
    [double]$s[0].CookedValue
}

function Get-SmbPairs {
    @(Get-SmbConnection -ErrorAction Stop | ForEach-Object { "$($_.ServerName)|$($_.ShareName)" })
}

function Save-SmbCounts([string]$Name) {
    $c = [pscustomobject]@{ opens = Get-SmbOpens; pairs = @(Get-SmbPairs) }
    ConvertTo-Json -InputObject $c | Set-Content "$env:RUNNER_TEMP\smb-$Name.json"
    Write-Host "SMB counts '$Name': server opens $($c.opens), connections $($c.pairs -join ', ')"
    $c
}

function Read-SmbCounts([string]$Name) {
    $path = "$env:RUNNER_TEMP\smb-$Name.json"
    if (-not (Test-Path $path)) { throw "No SMB counts were saved as '$Name'" }
    $c = Get-Content $path -Raw | ConvertFrom-Json
    if ($null -eq $c.opens) { throw "The SMB counts '$Name' have no open count" }
    $c
}

function Compare-SmbCounts($Before, $After) {
    [pscustomobject]@{
        opens = [double]$After.opens - [double]$Before.opens
        new   = @(@($After.pairs) | Where-Object { $_ -and $_ -notin @($Before.pairs) })
    }
}
