'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  PIPELINE_PROFILE_DEFAULT,
  PIPELINE_PROFILES,
  getPipelineProfile,
  getPipelineProfileNames,
  getPipelineProfileSet,
  getPipelineProfileSetNames
} = require('../src/config/pipelineProfiles');

const ROOT = path.resolve(__dirname, '..');
const SCANNER = path.join(ROOT, 'tools', 'scanVideoWithOcr.js');
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, 'data', 'video_profile_runs');

function printHelp() {
  console.log([
    'Usage: node tools/runOcrProfiles.js [options]',
    '',
    'Purpose:',
    '  Run one named OCR pipeline profile or a checked-in profile set against a video',
    '  without reconstructing experiment ideas from chat history.',
    '',
    'Options:',
    '  --list                       Print profile catalog and profile sets',
    '  --profile <name>            Run one profile (repeatable via comma list)',
    '  --set <name>                Run a named profile set (for example qmg-five-ideas)',
    '  --video <path>              Video to scan',
    '  --date <YYYYMMDD>           Optional date override; otherwise infer from filename',
    '  --output-root <path>        Root directory for all run outputs',
    '  --run-tag-prefix <name>     Prefix for per-profile run tags',
    '  --dry-run                   Print commands and environment without executing OCR',
    '  --help                      Show this help text',
    '',
    'Pass any extra scanVideoWithOcr.js flags after -- and they will be appended',
    'to every generated profile command.',
    '',
    'Examples:',
    '  node tools/runOcrProfiles.js --list',
    '  node tools/runOcrProfiles.js --set qmg-five-ideas --video data/video_pipeline/downloads_1080p/20220606_Axs8VyUKFRk.mp4 --date 20220606',
    '  node tools/runOcrProfiles.js --set qmg-five-ideas --video data/video_pipeline/downloads_1080p/20220606_Axs8VyUKFRk.mp4 --date 20220606 --dry-run',
    ''
  ].join('\n'));
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return null;
  }

  const options = {
    dryRun: false,
    extraScanArgs: [],
    list: false,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    profileNames: [],
    profileSet: null,
    runTagPrefix: null,
    videoPath: null,
    videoDate: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = argv[index + 1];

    if (argument === '--') {
      options.extraScanArgs = argv.slice(index + 1);
      break;
    }

    switch (argument) {
      case '--list':
        options.list = true;
        break;
      case '--dry-run':
      case '--print-only':
        options.dryRun = true;
        break;
      case '--profile':
      case '--profiles':
        options.profileNames.push(...String(nextValue || '').split(',').map((value) => value.trim()).filter(Boolean));
        index += 1;
        break;
      case '--set':
      case '--profile-set':
        options.profileSet = String(nextValue || '').trim();
        index += 1;
        break;
      case '--video':
        options.videoPath = path.resolve(nextValue);
        index += 1;
        break;
      case '--date':
        options.videoDate = String(nextValue || '').trim();
        index += 1;
        break;
      case '--output-root':
        options.outputRoot = path.resolve(nextValue);
        index += 1;
        break;
      case '--run-tag-prefix':
        options.runTagPrefix = String(nextValue || '').trim();
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function inferDateKey(videoPath, explicitDateKey) {
  if (explicitDateKey) {
    return explicitDateKey;
  }
  const match = path.basename(videoPath || '').match(/(20\d{6})/);
  return match ? match[1] : 'unknown';
}

function sanitizeRunTag(value) {
  return String(value || 'profile-run')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'profile-run';
}

function resolveRequestedProfiles(options) {
  if (options.profileSet && options.profileNames.length) {
    throw new Error('Pass either --set or --profile/--profiles, not both.');
  }

  if (options.profileSet) {
    return getPipelineProfileSet(options.profileSet).map((name) => getPipelineProfile(name));
  }

  if (options.profileNames.length) {
    return options.profileNames.map((name) => getPipelineProfile(name));
  }

  return [getPipelineProfile(PIPELINE_PROFILE_DEFAULT)];
}

function buildProfileEnv(profile) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(profile.env || {})) {
    env[key] = path.isAbsolute(value) ? value : path.resolve(ROOT, value);
  }
  return env;
}

function buildScanCommand(profile, options, dateKey) {
  const runTagBase = options.runTagPrefix || dateKey || path.basename(options.videoPath || 'video', path.extname(options.videoPath || ''));
  const runTag = sanitizeRunTag(`${runTagBase}_${profile.name}`);
  const args = [
    SCANNER,
    '--video', options.videoPath,
    '--pipeline-profile', profile.name,
    '--output-root', options.outputRoot,
    '--run-tag', runTag
  ];

  if (dateKey) {
    args.push('--date', dateKey);
  }

  args.push(...(profile.scanArgv || []));
  args.push(...(options.extraScanArgs || []));

  return { args, runTag };
}

function printCatalog() {
  console.log('Pipeline Profile Sets:');
  for (const setName of getPipelineProfileSetNames()) {
    console.log(`  ${setName}: ${getPipelineProfileSet(setName).join(', ')}`);
  }
  console.log('');
  console.log('Pipeline Profiles:');
  for (const profileName of getPipelineProfileNames()) {
    const profile = PIPELINE_PROFILES[profileName];
    console.log(`  ${profile.name}`);
    console.log(`    title: ${profile.title}`);
    console.log(`    family: ${profile.family}`);
    console.log(`    status: ${profile.status}`);
    console.log(`    description: ${profile.description}`);
    console.log(`    references: ${profile.references.length ? profile.references.join(', ') : '(none)'}`);
    console.log(`    scan argv: ${profile.scanArgv.length ? profile.scanArgv.join(' ') : '(none)'}`);
    if (Object.keys(profile.env || {}).length) {
      console.log(`    env: ${JSON.stringify(profile.env)}`);
    }
  }
}

function runProfile(profile, options, dateKey) {
  const { args, runTag } = buildScanCommand(profile, options, dateKey);
  const env = buildProfileEnv(profile);
  const commandLine = [process.execPath, ...args].map((value) => value.includes(' ') ? `"${value}"` : value).join(' ');

  console.log('');
  console.log(`=== ${profile.name} ===`);
  console.log(profile.title);
  console.log(profile.description);
  if (profile.references.length) {
    console.log(`refs: ${profile.references.join(', ')}`);
  }
  console.log(`run-tag: ${runTag}`);
  console.log(`command: ${commandLine}`);
  if (Object.keys(profile.env || {}).length) {
    console.log(`env: ${JSON.stringify(profile.env)}`);
  }

  if (options.dryRun) {
    return 0;
  }

  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env,
    stdio: 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  return Number(result.status || 0);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }

  if (options.list) {
    printCatalog();
    return;
  }

  if (!options.videoPath) {
    throw new Error('Missing required argument: --video');
  }

  const dateKey = inferDateKey(options.videoPath, options.videoDate);
  const profiles = resolveRequestedProfiles(options);

  console.log(`video: ${options.videoPath}`);
  console.log(`date: ${dateKey}`);
  console.log(`output-root: ${options.outputRoot}`);
  console.log(`profiles: ${profiles.map((profile) => profile.name).join(', ')}`);
  console.log(`mode: ${options.dryRun ? 'dry-run' : 'execute'}`);

  for (const profile of profiles) {
    const status = runProfile(profile, options, dateKey);
    if (status !== 0) {
      process.exitCode = status;
      return;
    }
  }
}

main();