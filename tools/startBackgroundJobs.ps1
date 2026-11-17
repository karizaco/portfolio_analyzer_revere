# Start the QMG background jobs: the 1080p downloader (with the fixed
# checkpoint logic) and the OCR queue runner.
#
# One downloader, one OCR runner -- no duplication. The census showed no
# downloader running before this, so this starts the only one.
$ErrorActionPreference = "Stop"
$repo = "C:\Users\admin\Projects\portfolio_analyzer_revere"
$logDir = Join-Path $repo "data\video_pipeline\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$dlLog = Join-Path $logDir "download_1080p_queue.log"
$ocrLog = Join-Path $logDir "ocr_queue.log"

$dl = Start-Process -FilePath "node" `
  -ArgumentList "tools/downloadQmg1080p.js","--limit","1000","--retry-errored" `
  -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $dlLog -RedirectStandardError "$dlLog.err"

$ocr = Start-Process -FilePath "node" `
  -ArgumentList "tools/qmgOcrQueueRunner.js","--chunk-size","5","--parallel","2" `
  -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $ocrLog -RedirectStandardError "$ocrLog.err"

Start-Sleep -Seconds 3
$state = [ordered]@{
  started_at = (Get-Date).ToString("o")
  downloader = [ordered]@{ pid = $dl.Id; log = $dlLog; args = "--limit 1000 --retry-errored" }
  ocr_queue  = [ordered]@{ pid = $ocr.Id; log = $ocrLog; args = "--chunk-size 5 --parallel 2" }
}
$state | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $logDir "background_jobs.json")
Write-Output ("downloader PID=" + $dl.Id)
Write-Output ("ocr queue PID=" + $ocr.Id)
