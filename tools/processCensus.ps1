<#
.SYNOPSIS
    An honest census of the machine's processes.

.DESCRIPTION
    WHY THIS EXISTS.

    On 2026-11-13 a measurement reported "5 yt-dlp processes". There
    were none. The command that counted them matched its OWN command
    line -- the pattern 'yt_dlp' appeared inside the measurement
    command -- so it counted itself, its bash wrapper and its powershell
    wrapper, and the number was reported as a fact about the machine.

    The fix is mechanical: a measurement must EXCLUDE ITSELF.

        $self, $parent, $grandparent ... are all excluded, because a
        measurement's own process tree is not what it is measuring.

    Everything this script prints is a count of processes that are NOT
    part of the measurement. That is what makes a number in a report
    quotable.

.PARAMETER Filter
    An optional regular expression matched against the command line. The
    pattern is read from here, but the MATCHING is done against every
    process's command line -- and this script's own command line is
    excluded before the match, so a pattern can never match itself.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/processCensus.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/processCensus.ps1 -Filter 'yt.dlp'
#>
[CmdletBinding()]
param(
    [string]$Filter = ''
)

$ErrorActionPreference = 'Continue'

# THE PROCESS TREE OF THIS MEASUREMENT, EXCLUDED.
#
# $PID is this script; its parent is the shell that launched it; and so
# on. Every one of them is part of the measurement, so none of them is
# part of what is measured.
$excludeIds = @{}
$current = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue
$guard = 0
while ($current -and $guard -lt 32) {
    $excludeIds[[int]$current.ProcessId] = $true
    $parentId = [int]$current.ParentProcessId
    if ($parentId -le 0) { break }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
    $guard += 1
}

$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$measured = @($all | Where-Object { -not $excludeIds.ContainsKey([int]$_.ProcessId) })

Write-Host "[census] $($all.Count) process(es) on the machine, $($measured.Count) measured"
Write-Host "[census] $($excludeIds.Count) excluded: this measurement's own process tree (so a pattern cannot match itself)"

if ($Filter) {
    $matched = @($measured | Where-Object { $_.CommandLine -and $_.CommandLine -match $Filter })
    Write-Host "[census] $($matched.Count) process(es) match /$Filter/:"
    foreach ($p in $matched) {
        $line = [string]$p.CommandLine
        if ($line.Length -gt 130) { $line = $line.Substring(0, 130) + '...' }
        Write-Host ("  {0,-8} {1,-12} {2}" -f $p.ProcessId, $p.Name, $line)
    }
    exit 0
}

$byName = $measured | Group-Object Name | Sort-Object Count -Descending
Write-Host ''
Write-Host '[census] by name:'
foreach ($group in $byName) {
    $mb = 0
    foreach ($p in $group.Group) { $mb += [math]::Round($p.WorkingSetSize / 1MB, 0) }
    Write-Host ("  {0,-22} {1,4}  {2,7} MB" -f $group.Name, $group.Count, $mb)
}

$heavy = @($measured | Where-Object { $_.WorkingSetSize -gt 200MB } | Sort-Object WorkingSetSize -Descending)
if ($heavy.Count -gt 0) {
    Write-Host ''
    Write-Host '[census] the heaviest:'
    foreach ($p in $heavy) {
        $mb = [math]::Round($p.WorkingSetSize / 1MB, 0)
        $line = [string]$p.CommandLine
        if ($line.Length -gt 110) { $line = $line.Substring(0, 110) + '...' }
        Write-Host ("  {0,-10} {1,6} MB  {2}" -f $p.Name, $mb, $line)
    }
}

exit 0
