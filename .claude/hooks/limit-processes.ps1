# The process-count guard.
#
# WHY THIS IS A FILE AND NOT AN INLINE COMMAND
#
# The first version of this hook was one long `powershell -NoProfile
# -Command "..."` string in .claude/settings.json. It looked right and it
# did NOTHING, because the harness runs a hook command through the shell:
# bash expanded `$inc`, `$_`, `$a`, `$p` and `$t` to empty strings before
# PowerShell ever saw them. The script then failed to parse, exited 1
# instead of 2, and a hook that exits with anything other than 2 is a
# NON-BLOCKING error in Claude Code.
#
# So the rule was committed on 2026-11-08 and was a silent no-op for
# every session since -- and on 2026-11-13 a suite run was observed with
# 97 node.exe processes alive (the test runner starts one process per test
# file, and this repository has 98 test files) while the machine was
# reported as frozen.
#
# A file has no shell interpolation, so it cannot be mangled that way.
#
# WHAT IT DOES
#
#   1. `npm test` is refused outright. The suite is the one command in
#      this repository that fans out to ~100 processes, and the user can
#      run it themselves in a terminal where they can see it.
#   2. Any other command is refused when the project already has too
#      many of its own processes running: node >= 6, python >= 4.
#
# The harness's own ~30 MCP and VSCode processes are NOT counted. They
# match neither the project's paths nor its tool names, and counting them
# would make the guard fire on everything.
#
# EXIT CODES
#
#   0  allow
#   2  BLOCK -- the stderr message is shown to the agent
#   1  a hook error, which Claude Code treats as NON-blocking
#
# So every failure path here must exit 2, and never 1.

$ErrorActionPreference = 'Stop'

# A process belongs to the project when its command line names the
# repository, one of its tools, a test path, or one of its run trees.
#
# NOTE THE `node.exe\s+-e` FORM. A RUNNING PROCESS's command line reads
# "node.exe -e ...", not the "node -e ..." an agent types, so the typed
# form alone never matched anything -- which is why the count branch of
# the original hook never fired either. There is deliberately NO bare
# "node.exe" here: that would match the harness's own CLI process.
$include = 'portfolio_analyzer_revere|node\.exe"?\s+-e|node\s+-e|\bnpm\b|\bnpx\b|easyocr|tools[\\/]|test[\\/]|_rerun|qmg|scanVideo|whiteboard_worker'

# The harness's own processes are not the project's, even when they are
# node or python: the MCP servers, the VSCode extension host, Playwright,
# every installed package tree, and node_modules (whose paths contain
# "test" often enough to count).
$exclude = 'mcp|vscode|playwright|uv\.cache|site-packages|extensions|\.minimax|node_modules'

$NODE_CAP = 6
$PYTHON_CAP = 4

# The hook's input arrives on stdin as JSON; the command is somewhere in
# it. Reading it whole is the only way to see a command that is quoted or
# piped, and reading it to the end is safe because the harness closes the
# stream.
$hookInput = [Console]::In.ReadToEnd()
$command = ''
if ($hookInput) {
    try {
        $parsed = $hookInput | ConvertFrom-Json
        $command = [string]$parsed.tool_input.command
    } catch {
        $command = $hookInput
    }
}

function Stop-With($message) {
    [Console]::Error.WriteLine($message)
    exit 2
}

# 1. The suite. It is the one command here that starts a process per test
#    file, and the count is a property of the repository, not of the
#    machine: 98 test files means ~98 processes.
#
#    `npm run test:benchmark` is deliberately ALLOWED: it is a single
#    file, so it is one process. It is slow, not wide.
if (($command -match 'npm\s+(run\s+)?test') -and ($command -notmatch 'test:benchmark')) {
    Stop-With ('BLOCKED: `npm test` starts one node process per test file -- this ' +
        'repository has 98 of them, so the suite is ~97 processes at once. Run it ' +
        'yourself in a terminal, or run the files you need: ' +
        '`node --test --test-concurrency=8 test/<file>.test.js`.')
}

# 1b. THE CLEANUP COMMANDS ARE ALWAYS ALLOWED. A guard that blocks the
#     command that fixes the situation it is complaining about is a
#     deadlock: the message says "kill the orphans" and then refuses the
#     kill. So `taskkill`, `Stop-Process` and `tasklist` are always let
#     through -- they are the remedy, and they do not add processes.
if ($command -match 'taskkill|Stop-Process|tasklist') {
    exit 0
}

# 2. The project already has too many of its own processes running.
try {
    $all = Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object { $_.Name -match '^(node|python|pythonw)' }
    $project = @($all | Where-Object {
        $_.CommandLine -and ($_.CommandLine -match $include) -and ($_.CommandLine -notmatch $exclude)
    })
    $node = @($project | Where-Object { $_.Name -match '^node' }).Count
    $python = @($project | Where-Object { $_.Name -match '^python' }).Count
} catch {
    # A guard that cannot see must not block: an unreadable process list
    # is not evidence that the machine is busy. Exiting 1 here would be
    # a silent no-op, which is how this rule spent a week doing nothing.
    exit 0
}

if (($node -ge $NODE_CAP) -or ($python -ge $PYTHON_CAP)) {
    Stop-With ('BLOCKED process-count guard: this project already has node=' + $node +
        ' python=' + $python + ' running (caps: node ' + $NODE_CAP + ', python ' +
        $PYTHON_CAP + '). The harness MCP and VSCode processes are not counted. ' +
        'Let one finish first, or kill the orphans: ' +
        'tasklist //FI "IMAGENAME eq node.exe" //FO CSV')
}

exit 0
