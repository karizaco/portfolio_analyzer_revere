const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function escapePowerShellSingleQuotes(value) {
  return value.replace(/'/g, "''");
}

async function resolveShortcutTarget(inputPath) {
  if (!inputPath.toLowerCase().endsWith('.lnk')) {
    return inputPath;
  }

  const script = [
    `$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut('${escapePowerShellSingleQuotes(inputPath)}')`,
    '$shortcut.TargetPath'
  ].join('; ');

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-Command', script],
    { windowsHide: true }
  );

  const target = stdout.trim();
  if (!target) {
    throw new Error(`Unable to resolve shortcut target for ${inputPath}`);
  }

  return target;
}

module.exports = {
  resolveShortcutTarget
};
