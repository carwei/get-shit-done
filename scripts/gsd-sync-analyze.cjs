#!/usr/bin/env node
/**
 * Analyze .planning index state across two branches and output structured facts
 * for /gsd:sync to act on — no LLM parsing of raw git output needed.
 *
 * Usage: node scripts/gsd-sync-analyze.cjs [--target=<branch>]
 * Output: plain-text fact sheet consumed by /gsd:sync Step 2–3.
 * Note: always compares against origin/<branch> so local stale state doesn't mislead.
 */

'use strict';

const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const targetArg = args.find(a => a.startsWith('--target='));
const targetBranch = targetArg ? targetArg.split('=')[1] : 'main';

// Always compare against the remote ref so local stale state doesn't mislead.
// Falls back to the bare branch name if origin/<branch> doesn't exist (e.g. offline).
function resolveTargetRef(branch) {
  try {
    execSync(`git rev-parse --verify origin/${branch}`, { stdio: 'ignore' });
    return `origin/${branch}`;
  } catch {
    return branch;
  }
}

const TARGET = resolveTargetRef(targetBranch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function lines(str) {
  return str.split('\n').map(l => l.trim()).filter(Boolean);
}

/** Extract bare directory names from `git ls-tree --name-only` output. */
function parseDirs(raw) {
  return lines(raw).map(l => l.split('/').pop());
}

/**
 * From `git ls-tree -r --name-only <ref> -- .planning/milestones/` output,
 * extract { version, dirName } pairs for phase archive directories.
 * Path shape: .planning/milestones/<ver>-phases/<dirName>/<file>  (5 segments)
 */
function parseArchivedPhases(raw) {
  const seen = new Set();
  const result = [];
  for (const line of lines(raw)) {
    const parts = line.split('/');
    // parts: ['.planning', 'milestones', '<ver>-phases', '<dirName>', '<file>']
    if (parts.length !== 5) continue;
    const versionFolder = parts[2]; // e.g. "v1.8-phases"
    const dirName = parts[3];       // e.g. "22-data-fields"
    if (!versionFolder.endsWith('-phases')) continue;
    if (seen.has(dirName)) continue;
    seen.add(dirName);
    const version = versionFolder.replace(/-phases$/, '');
    result.push({ version, dirName });
  }
  return result;
}

/** Extract the leading integer from a directory name like "22-data-fields" → 22. */
function prefixNum(dirName) {
  const m = dirName.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Gather data
// ---------------------------------------------------------------------------

const currentBranch = git('branch --show-current');

// Target
const targetPhasesRaw   = git(`ls-tree --name-only ${TARGET} -- .planning/phases/`);
const targetQuicksRaw   = git(`ls-tree --name-only ${TARGET} -- .planning/quick/`);
const targetMilestonesRaw = git(`ls-tree -r --name-only ${TARGET} -- .planning/milestones/`);

const targetPhases   = parseDirs(targetPhasesRaw);
const targetQuicks   = parseDirs(targetQuicksRaw);
const targetArchived = parseArchivedPhases(targetMilestonesRaw);

const targetArchivedDirs = targetArchived.map(a => a.dirName);
const targetAllDirs      = [...new Set([...targetPhases, ...targetArchivedDirs])];
const targetAllNums      = new Set(targetAllDirs.map(prefixNum).filter(n => n !== null));
const targetMaxPhase     = targetAllNums.size ? Math.max(...targetAllNums) : 0;
const targetQuickNums    = new Set(targetQuicks.map(prefixNum).filter(n => n !== null));
const targetMaxQuick     = targetQuickNums.size ? Math.max(...targetQuickNums) : 0;

// Local (HEAD)
const localPhasesRaw    = git(`ls-tree --name-only HEAD -- .planning/phases/`);
const localQuicksRaw    = git(`ls-tree --name-only HEAD -- .planning/quick/`);
const localMilestonesRaw = git(`ls-tree -r --name-only HEAD -- .planning/milestones/`);

const localPhases   = parseDirs(localPhasesRaw);
const localQuicks   = parseDirs(localQuicksRaw);
const localArchived = parseArchivedPhases(localMilestonesRaw);

const localArchivedDirs = localArchived.map(a => a.dirName);
const localAllDirs      = [...new Set([...localPhases, ...localArchivedDirs])];
const localQuickNums    = new Set(localQuicks.map(prefixNum).filter(n => n !== null));

// ---------------------------------------------------------------------------
// Conflict analysis
// ---------------------------------------------------------------------------

const targetDirSet = new Set(targetAllDirs);
const localDirSet  = new Set(localAllDirs);

// Branch-local: exist in local but NOT verbatim in target
const branchLocalPhases = localAllDirs.filter(d => !targetDirSet.has(d));
const branchLocalQuicks = localQuicks.filter(d => !targetQuicks.includes(d));

// Conflicting: branch-local AND their number collides with a target number
const conflictingPhases = branchLocalPhases.filter(d => {
  const n = prefixNum(d);
  return n !== null && targetAllNums.has(n);
});
const conflictingQuicks = branchLocalQuicks.filter(d => {
  const n = prefixNum(d);
  return n !== null && targetQuickNums.has(n);
});

// Target-only: exist in target but NOT verbatim in local
const targetOnlyPhases = targetPhases.filter(d => !localDirSet.has(d));

// Annotate branch-local phases with location and conflict info
function annotate(dirName) {
  const isActive   = localPhases.includes(dirName);
  const archEntry  = localArchived.find(a => a.dirName === dirName);
  const location   = isActive ? 'active' : archEntry ? `archived (${archEntry.version})` : 'unknown';
  const num        = prefixNum(dirName);
  const targetMatch = targetAllDirs.find(t => prefixNum(t) === num && t !== dirName);
  const conflict   = conflictingPhases.includes(dirName)
    ? `CONFLICTS with ${targetMatch} on ${TARGET}`
    : 'no conflict';
  return `  ${dirName}  [${location}]  →  ${conflict}`;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log(`GSD Sync Analysis`);
console.log(`=================`);
console.log(`Current branch : ${currentBranch}`);
console.log(`Target branch  : ${TARGET}`);
console.log();

console.log(`TARGET (${TARGET})`);
console.log(`  Active phases    : ${targetPhases.join(', ') || '(none)'}`);
console.log(`  Archived phases  : ${targetArchivedDirs.join(', ') || '(none)'}`);
console.log(`  All phase nums   : ${[...targetAllNums].sort((a,b)=>a-b).join(', ') || '(none)'}  (max: ${targetMaxPhase})`);
console.log(`  Quicks           : ${targetQuicks.join(', ') || '(none)'}  (max: ${targetMaxQuick})`);
console.log();

console.log(`LOCAL (HEAD)`);
console.log(`  Active phases    : ${localPhases.join(', ') || '(none)'}`);
console.log(`  Archived phases  : ${localArchivedDirs.join(', ') || '(none)'}`);
console.log(`  Quicks           : ${localQuicks.join(', ') || '(none)'}`);
console.log();

console.log(`BRANCH-LOCAL PHASES (exist locally, not on ${TARGET} by exact name)`);
if (branchLocalPhases.length === 0) {
  console.log(`  (none)`);
} else {
  branchLocalPhases.forEach(d => console.log(annotate(d)));
}
console.log();

console.log(`BRANCH-LOCAL QUICKS`);
if (branchLocalQuicks.length === 0) {
  console.log(`  (none)`);
} else {
  branchLocalQuicks.forEach(d => {
    const n = prefixNum(d);
    const conflict = targetQuickNums.has(n) ? `CONFLICTS (${n} used on ${TARGET})` : 'no conflict';
    console.log(`  ${d}  →  ${conflict}`);
  });
}
console.log();

console.log(`TARGET-ONLY PHASES (on ${TARGET} but not locally — ROADMAP absorption needed)`);
if (targetOnlyPhases.length === 0) {
  console.log(`  (none)`);
} else {
  targetOnlyPhases.forEach(d => console.log(`  ${d}`));
}
console.log();

const hasWork = conflictingPhases.length > 0 || conflictingQuicks.length > 0 || targetOnlyPhases.length > 0;
if (hasWork) {
  console.log(`SUMMARY: Action required — see CONFLICTS and TARGET-ONLY above.`);
} else {
  console.log(`SUMMARY: Nothing to sync — no index conflicts with ${TARGET}.`);
}
