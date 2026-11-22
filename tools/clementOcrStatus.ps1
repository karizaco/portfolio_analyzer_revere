# tools/clementOcrStatus.ps1 — status of Clement dashboard OCR batch + our PIDs
param()
$ErrorActionPreference = 'Continue'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -ErrorAction SilentlyContinue
if (-not $root) { $root = (Get-Location).Path }
# script lives in tools/
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$batch = Join-Path $root 'data/discord_pipeline/media/clement/ocr_split_batch'
$pidFile = Join-Path $batch 'batch_pids.json'

Write-Host "time=$(Get-Date -Format o)"
Write-Host "batch_dir=$batch"

# disk progress
$left = @(Get-ChildItem (Join-Path $batch '*_LEFT.txt') -EA SilentlyContinue)
$meta = @(Get-ChildItem (Join-Path $batch '*_meta.json') -EA SilentlyContinue)
$tmps = @(Get-ChildItem (Join-Path $batch '_tmp_*') -EA SilentlyContinue)
$prog = Get-Item (Join-Path $batch 'progress.jsonl') -EA SilentlyContinue
Write-Host "LEFT_txt=$($left.Count) META=$($meta.Count) tmp_in_flight=$($tmps.Count) target=64"
if ($prog) {
  Write-Host "progress.jsonl bytes=$($prog.Length) mtime=$($prog.LastWriteTime.ToString('o'))"
}
if ($tmps.Count) {
  Write-Host "tmp_files:" ($tmps.Name -join ', ')
}

# known PID file
$known = @()
if (Test-Path $pidFile) {
  try { $known = Get-Content $pidFile -Raw | ConvertFrom-Json } catch { $known = @() }
  Write-Host "pid_file_entries=$($known.Count)"
}

# live python/py with high CPU or matching start pattern
$live = @()
Get-Process python, py -EA SilentlyContinue | ForEach-Object {
  $cpuMin = [math]::Round($_.TotalProcessorTime.TotalMinutes, 1)
  $ws = [math]::Round($_.WorkingSet64 / 1MB, 0)
  $row = [pscustomobject]@{
    Pid = $_.Id
    Name = $_.ProcessName
    CpuMin = $cpuMin
    WsMB = $ws
    StartTime = $_.StartTime
    LikelyOcr = ($_.ProcessName -eq 'python' -and ($cpuMin -gt 5 -or $ws -gt 200))
  }
  $live += $row
}

$ocr = @($live | Where-Object { $_.LikelyOcr })
$launchers = @($live | Where-Object { $_.Name -eq 'py' -and $_.WsMB -lt 5 })
Write-Host "live_python=$($live | Where-Object Name -eq 'python' | Measure-Object | Select-Object -ExpandProperty Count) likely_ocr_workers=$($ocr.Count) idle_py_launchers=$($launchers.Count)"
$ocr | Sort-Object StartTime | Format-Table Pid, CpuMin, WsMB, StartTime -AutoSize
if ($left.Count -gt 0) {
  $newest = $left | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  Write-Host "newest_LEFT=$($newest.Name) at $($newest.LastWriteTime.ToString('o'))"
}
