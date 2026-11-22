# tools/clementOcrStartOne.ps1 — start EXACTLY one resume-safe OCR batch and record PIDs
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$batch = Join-Path $root 'data/discord_pipeline/media/clement/ocr_split_batch'
New-Item -ItemType Directory -Force -Path $batch | Out-Null
$pidFile = Join-Path $batch 'batch_pids.json'
$status = Join-Path $PSScriptRoot 'clementOcrStatus.ps1'

Write-Host '=== BEFORE START ==='
& $status

# Refuse to start a second wave if likely OCR workers already exist
$existing = @(Get-Process python -EA SilentlyContinue | Where-Object {
  $_.TotalProcessorTime.TotalMinutes -gt 5 -or $_.WorkingSet64 -gt 200MB
})
if ($existing.Count -gt 0) {
  Write-Host "REFUSING START: $($existing.Count) likely OCR python worker(s) already running:"
  $existing | ForEach-Object { Write-Host "  PID=$($_.Id) CPU_min=$([math]::Round($_.TotalProcessorTime.TotalMinutes,1)) WS_MB=$([math]::Round($_.WorkingSet64/1MB,0))" }
  Write-Host 'Kill duplicates first, or wait. Only one batch should run.'
  exit 2
}

$env:PYTHONUNBUFFERED = '1'
$env:OMP_NUM_THREADS = '1'
$env:MKL_NUM_THREADS = '1'
$env:OPENBLAS_NUM_THREADS = '1'
$env:NUMEXPR_NUM_THREADS = '1'
$env:KMP_DUPLICATE_LIB_OK = 'TRUE'
$env:CUDA_VISIBLE_DEVICES = ''

$stdout = Join-Path $batch 'batch_stdout.log'
$stderr = Join-Path $batch 'batch_stderr.log'
$proc = Start-Process -FilePath 'py' -ArgumentList @('-3','-u', (Join-Path $root 'tools/clementBatchDashboardOcr.py')) `
  -WorkingDirectory $root.Path `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

$record = @(
  [pscustomobject]@{
    role = 'launcher_py'
    pid = $proc.Id
    started_at = (Get-Date).ToString('o')
    cmd = 'py -3 -u tools/clementBatchDashboardOcr.py'
  }
)
# wait briefly for python child
Start-Sleep -Seconds 3
Get-Process python -EA SilentlyContinue | Where-Object { $_.StartTime -ge $proc.StartTime.AddSeconds(-2) } | ForEach-Object {
  $record += [pscustomobject]@{
    role = 'python_worker'
    pid = $_.Id
    started_at = $_.StartTime.ToString('o')
    cmd = 'python child of OCR batch (cmdline often inaccessible in sandbox)'
  }
}
$record | ConvertTo-Json | Set-Content -Encoding utf8 $pidFile
Write-Host "STARTED launcher_pid=$($proc.Id) pid_file=$pidFile"
Write-Host '=== AFTER START ==='
& $status
