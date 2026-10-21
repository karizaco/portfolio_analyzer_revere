'use strict';

/**
 * PreToolUse guard for Bash commands.
 *
 * Wired up in .claude/settings.json. Exits 2 (block) with a reason on stderr
 * when the command matches a destructive pattern; exits 0 otherwise.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-10-21 a `git sparse-checkout add test` command destroyed ~215 GB of
 * downloaded YouTube videos (718 files under data/video_pipeline/). Those
 * files were untracked and gitignored, so git could not restore them.
 *
 * The pattern set in .git/info/sparse-checkout excluded data/video_pipeline/,
 * and re-applying the sparse set pruned that directory tree out of the
 * working tree, taking the untracked media with it.
 *
 * The repo has since had sparse-checkout disabled entirely
 * (core.sparseCheckout=false), so there is no pattern set left to re-apply.
 * This hook is the second line of defence: it refuses to let anyone turn
 * sparse-checkout back on, and refuses the other commands that could take
 * the media out from under us.
 */

const fs = require('node:fs');

const PROJECT_DIR = 'C:/Users/Admin/Projects/portfolio_analyzer_revere';

// Media that cannot be re-created locally. Losing it means re-downloading
// ~215 GB from YouTube.
const IRREPLACEABLE = [
  'video_pipeline',
  'downloads_1080p',
  'downloads_hires',
  'state.sqlite',
  // The out-of-tree media directory the re-downloads land in. It is a sibling
  // of the project, so it must be named explicitly — a bare "outside the
  // project" rule would cover it, but naming it makes the intent obvious.
  'portfolio_analyzer_revere_media',
];

/**
 * Remove the body of a commit message / script from the command before
 * inspecting it.
 *
 * `git commit -m "...git sparse-checkout add test..."` *describes* the
 * dangerous command; it does not run it. Without this, documenting the
 * incident would be impossible to commit. Only the flag's own value is
 * stripped — the rest of the command line is still inspected in full.
 */
function stripMessageBodies(command) {
  return command
    .replace(/(-m|--message|-F|--file)\s+"[^"]*"/g, '$1 ""')
    .replace(/(-m|--message)\s+'[^']*'/g, "$1 ''")
    .replace(/<<'?[A-Z_]+'?\s*(\r?\n[\s\S]*)?$/m, '');
}

/**
 * Is this path inside the project working tree?
 *
 * The boundary check must be on a path *separator*, not a bare prefix. The
 * media directory `portfolio_analyzer_revere_media` is a sibling of the
 * project, not a child of it — a bare `startsWith` would wrongly treat it as
 * inside the project and leave it unprotected.
 */
function isInsideProject(normalizedPath) {
  const project = PROJECT_DIR.replace(/\\/g, '/').toLowerCase();
  const p = normalizedPath.toLowerCase();
  if (p === project) return true;
  return p.startsWith(project.endsWith('/') ? project : project + '/');
}

/**
 * @param {string} command
 * @returns {{rule: string, reason: string}|null}
 */
function findViolation(command) {
  if (!command) return null;
  const cmd = stripMessageBodies(command);

  // 1. Never re-enable or re-apply sparse-checkout. `list` is read-only and
  //    allowed; `disable` only ever materializes MORE files, so it is allowed.
  const sparse = cmd.match(/\bgit\s+sparse-checkout\s+([a-z-]+)/i);
  if (sparse) {
    const sub = sparse[1].toLowerCase();
    if (sub !== 'list' && sub !== 'disable') {
      return {
        rule: 'sparse-checkout',
        reason:
          'BLOCKED: `git sparse-checkout ' + sub + '` can prune directories out of the ' +
          'working tree, including untracked files (this destroyed 215 GB of downloaded ' +
          'videos on 2026-10-21). Sparse-checkout is disabled in this repo and must stay ' +
          'disabled. Use `git sparse-checkout list` (read-only) if you need to inspect it. ' +
          'To change which files are tracked, edit .gitignore — never the sparse-checkout set.',
      };
    }
  }

  // 2. Do not re-enable sparse-checkout via raw config.
  //    Scoped to `git config`'s own arguments, so a later unrelated command on
  //    the same line cannot trigger it by accident.
  const configMatch = cmd.match(/\bgit\s+config\b((?:\s+-{1,2}[A-Za-z][\w-]*)*(?:\s+[^\s]+)*)/);
  if (configMatch && /core\.sparseCheckout(Cone)?\s+true/i.test(configMatch[1])) {
    return {
      rule: 'sparse-checkout-config',
      reason:
        'BLOCKED: enabling core.sparseCheckout (or core.sparseCheckoutCone) re-arms the ' +
        'mechanism that destroyed 215 GB of downloaded videos on 2026-10-21.',
    };
  }

  // 3. `git clean` deletes untracked files — which is where the media lives.
  //    The force flag must be one of `git clean`'s OWN flags. Matching it
  //    loosely (e.g. `git clean[^\n]*-f`) makes the rule fire on an unrelated
  //    `rm -f` later in the same command line, which blocks safe commands.
  const cleanMatch = cmd.match(/\bgit\s+clean\b((?:\s+-{1,2}[A-Za-z][\w-]*)*)/);
  if (cleanMatch && /(^|\s)-{1,2}[A-Za-z]*f/i.test(cleanMatch[1])) {
    return {
      rule: 'git-clean',
      reason:
        'BLOCKED: `git clean -f` deletes untracked files. The downloaded videos are ' +
        'untracked by design (.gitignore), so this would destroy them irrecoverably.',
    };
  }

  // 4. Recursive deletes that target the media directory or the git dir.
  const recursiveDelete =
    /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]|rmdir\s+\/s|Remove-Item[^\n]*-Recurse/i;
  if (!recursiveDelete.test(cmd)) {
    // No recursive delete in this command. Nothing below can apply — a plain
    // `cp`/`ls`/`cat` that merely mentions a path outside the project is
    // harmless and must not be blocked.
    return null;
  }

  const lowered = cmd.toLowerCase();
  for (const target of IRREPLACEABLE) {
    if (lowered.includes(target.toLowerCase())) {
      return {
        rule: 'recursive-delete-media',
        reason:
          'BLOCKED: this recursive delete targets `' + target + '`, which holds media or ' +
          'data that cannot be re-created locally (the downloaded videos require a ' +
          '~215 GB re-download from YouTube). Narrow the delete to a scratch directory, ' +
          'or ask the user to approve the exact paths.',
      };
    }
  }
  if (/\.git\b/.test(cmd)) {
    return {
      rule: 'recursive-delete-git',
      reason: 'BLOCKED: recursive delete targeting the .git directory.',
    };
  }

  // 5. Recursive deletes aimed outside the project (other drives, user folders).
  //    Matches Windows paths (C:/...) and Git-Bash style paths, including the
  //    single-letter mount points that map the other drives (/d/, /f/, /p/).
  const absoluteTargets = cmd.match(
    /[A-Za-z]:[\\\/][^\s'"]+|\/(?:[a-z]\/|[A-Z][a-z]+\/|Users\/|mnt\/|home\/)[^\s'"]*/g
  ) || [];
  const tempLike = /(^|[\\\/])(tmp|temp|Temp|C:[\/\\]tmp)([\\\/]|$)/;
  for (const target of absoluteTargets) {
    const normalized = target.replace(/\\/g, '/');
    if (isInsideProject(normalized)) continue;
    if (tempLike.test(normalized)) continue;
    if (/^\/(tmp|var|opt|usr|etc)\//.test(normalized)) continue;
    return {
      rule: 'recursive-delete-outside-project',
      reason:
        'BLOCKED: recursive delete targets a path outside the project directory (' +
        target + '). The user\'s other drives and personal files are not ours to delete. ' +
        'Ask the user to approve the exact paths instead.',
    };
  }

  return null;
}

function main() {
  let payload = '';
  try {
    payload = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  let command = '';
  try {
    const parsed = JSON.parse(payload);
    command = (parsed.tool_input && parsed.tool_input.command) || '';
  } catch (_) {
    // If we cannot parse the payload we cannot judge it — allow, but the
    // rules above are a safety net, not the primary defence.
    process.exit(0);
  }

  const violation = findViolation(command);
  if (violation) {
    process.stderr.write(violation.reason + '\n');
    process.exit(2);
  }
  process.exit(0);
}

main();
