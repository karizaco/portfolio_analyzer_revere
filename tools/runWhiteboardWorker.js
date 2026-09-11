const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workerPath = path.join(__dirname, 'whiteboard_worker.py');

function getCandidateLaunchers() {
  if (process.platform === 'win32') {
    return [
      { args: ['-3'], command: 'py' },
      { args: [], command: 'python' },
      { args: [], command: 'python3' }
    ];
  }

  return [
    { args: [], command: 'python3' },
    { args: [], command: 'python' }
  ];
}

function isLauncherAvailable(launcher) {
  const result = spawnSync(launcher.command, [...launcher.args, '--version'], {
    encoding: 'utf8',
    stdio: 'pipe'
  });

  return !result.error && result.status === 0;
}

function main() {
  if (!fs.existsSync(workerPath)) {
    console.error(`Whiteboard worker not found: ${workerPath}`);
    process.exit(1);
  }

  const launcher = getCandidateLaunchers().find(isLauncherAvailable);
  if (!launcher) {
    console.error('No Python 3 launcher was found. Tried py -3, python, and python3.');
    process.exit(1);
  }

  const result = spawnSync(
    launcher.command,
    [...launcher.args, workerPath, ...process.argv.slice(2)],
    { stdio: 'inherit' }
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

main();