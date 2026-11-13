<#
.SYNOPSIS
    Kill node.exe processes -- and NOTHING ELSE.

.DESCRIPTION
    THE RULE THIS FILE ENFORCES: when the user says "kill the node
    processes", that means node.exe and nothing else. Python is a
    different program, it runs the MCP servers this session's tools
    depend on, and it runs yt-dlp, which is what the download and
    metadata jobs are made of. Killing it by accident is not a
    recoverable nuisance.

    So this helper:

      * enumerates node.exe and prints each PID with its command line
        BEFORE killing it, so the decision is visible and checkable;
      * kills ONLY node.exe -- the name filter is the literal string
        'node.exe', and nothing else is ever passed to taskkill;
      * NEVER kills ITS OWN PROCESS TREE -- the caller, the shell that
        launched it, and everything above them. A node process running
        this script would otherwise kill the test runner that started
        it, and an agent's own harness could be one of them;
      * does NOT use /T (kill the process tree). A node worker can own
        python children -- the dating campaign's worker owns up to six
        yt-dlp children -- and a tree kill would take them with it. The
        orphans are REPORTED instead, and whether they die is the user's
        call, not this script's;
      * prints what it killed and what it found afterwards.

.PARAMETER What
    'node' (the default) kills node.exe. No other target is accepted:
    the point of this script is that the blast radius cannot widen by
    accident.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/killNodeProcesses.ps1
#>
[CmdletBinding()]
param(
    [ValidateSet('node')]
    [string]$What = 'node'
)

$ErrorActionPreference = 'Continue'

function Get-NodeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
}

function Get-SelfTreeIds {
    # THIS SCRIPT'S OWN PROCESS TREE: this script, the shell that
    # launched it, and everything above. Those are never killed -- a
    # helper that kills the caller is a helper that kills the session.
    $ids = @{}
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue
    $guard = 0
    while ($current -and $guard -lt 32) {
        $ids[[int]$current.ProcessId] = $true
        $parentId = [int]$current.ParentProcessId
        if ($parentId -le 0) { break }
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
        $guard += 1
    }
    return $ids
}

function Get-DescendantIds([int[]]$Roots) {
    # The children of the processes being killed. Reported, not killed.
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $children = @{}
    foreach ($p in $all) {
        if (-not $children.ContainsKey([int]$p.ParentProcessId)) {
            $children[[int]$p.ParentProcessId] = @()
        }
        $children[[int]$p.ParentProcessId] += $p
    }
    $descendants = @()
    $queue = [System.Collections.Generic.Queue[int]]::new()
    foreach ($root in $Roots) { $queue.Enqueue($root) }
    while ($queue.Count -gt 0) {
        $id = $queue.Dequeue()
        if ($children.ContainsKey($id)) {
            foreach ($child in $children[$id]) {
                $descendants += $child
                $queue.Enqueue([int]$child.ProcessId)
            }
        }
    }
    return $descendants
}

$self = Get-SelfTreeIds
$allNode = Get-NodeProcesses
$targets = @($allNode | Where-Object { -not $self.ContainsKey([int]$_.ProcessId) })
$protected = @($allNode | Where-Object { $self.ContainsKey([int]$_.ProcessId) })

Write-Host "[kill-node] target: node.exe only. $($targets.Count) process(es) to kill, $($protected.Count) protected."

if ($protected.Count -gt 0) {
    Write-Host '[kill-node] protected (this script and its own process tree -- never killed):'
    foreach ($p in $protected) {
        $line = [string]$p.CommandLine
        if ($line.Length -gt 110) { $line = $line.Substring(0, 110) + '...' }
        Write-Host ("  {0,-8} {1}" -f $p.ProcessId, $line)
    }
}

if ($targets.Count -eq 0) {
    Write-Host '[kill-node] nothing to kill.'
    exit 0
}

Write-Host '[kill-node] what will be killed:'
foreach ($p in $targets) {
    $line = [string]$p.CommandLine
    if ($line.Length -gt 120) { $line = $line.Substring(0, 120) + '...' }
    Write-Host ("  {0,-8} {1}" -f $p.ProcessId, $line)
}

# The children are collected BEFORE the kill, so their parent is still
# known. They are reported and left alive.
$orphans = Get-DescendantIds -Roots @($targets | ForEach-Object { [int]$_.ProcessId })

$killed = 0
$failed = 0
foreach ($p in $targets) {
    # The literal target name. Nothing else can be reached from here.
    $result = & taskkill.exe /PID $p.ProcessId /F 2>&1
    if ($LASTEXITCODE -eq 0) {
        $killed += 1
    } else {
        $failed += 1
        Write-Host ("  could not kill {0}: {1}" -f $p.ProcessId, ($result -join ' '))
    }
}

$remaining = @(Get-NodeProcesses | Where-Object { -not $self.ContainsKey([int]$_.ProcessId) })
Write-Host "[kill-node] killed $killed, failed $failed, node.exe remaining (excluding the protected tree): $($remaining.Count)"

$pythonLeft = @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue)
Write-Host "[kill-node] python processes still running: $($pythonLeft.Count) -- NOT touched by this script."

if ($orphans.Count -gt 0) {
    Write-Host ''
    Write-Host '[kill-node] these processes were CHILDREN of the killed ones and are still alive:'
    foreach ($o in $orphans) {
        $line = [string]$o.CommandLine
        if ($line.Length -gt 120) { $line = $line.Substring(0, 120) + '...' }
        Write-Host ("  {0,-8} {1,-12} {2}" -f $o.ProcessId, $o.Name, $line)
    }
    Write-Host '[kill-node] they were NOT killed -- this script does not use /T, because a'
    Write-Host '[kill-node] node worker owns python children (yt-dlp) and killing the tree'
    Write-Host '[kill-node] would take them too. Say so explicitly if you want them gone.'
}

exit 0
