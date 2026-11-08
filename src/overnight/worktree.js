'use strict';
// Overnight worktrees: one throwaway git worktree + branch per queued task, so a
// night run never touches the user's own working tree (design new-features.md §8,
// common rule "作業ツリーを勝手に変えない"). The machinery itself — create,
// remove, the junction handling — is the shared src/worktree-pool.js (race
// uses it too); what stays here is overnight's own shape on top of it: the
// folder/branch naming, and committing a finished run onto its branch.
//
// git is driven through an injectable runGit(argv, cwd) -> {ok, stdout, stderr}
// so tests never need a real repository history beyond a temp repo, and the
// default runner is a plain spawnSync (no shell, so paths are never re-parsed).
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../worktree-pool.js');

const defaultRunGit = pool.defaultRunGit;

// Where a run's worktrees live: %LOCALAPPDATA%\muser\overnight\worktrees\<runId>\<taskId>
// (never inside the user's repository, so listing/cleanup cannot collide with
// their own worktrees there beyond the registration git itself keeps).
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task'; }

function branchNameFor(taskId, at = new Date()) {
  const p = n => String(n).padStart(2, '0');
  // Seconds included: branches are kept forever, so re-running the same
  // item within the same minute used to collide with its own earlier
  // branch and fail the task (features-debug #36).
  const stamp = at.getFullYear() + p(at.getMonth() + 1) + p(at.getDate()) + '-' + p(at.getHours()) + p(at.getMinutes()) + p(at.getSeconds());
  // A random suffix on every name (wave 11): seconds made two runs of the
  // same item within the same second collide, and a deferred item re-run
  // in that second failed on its own earlier branch.
  const suffix = Math.floor(Math.random() * 2176782336).toString(36).padStart(6, '0');
  return 'overnight/' + stamp + '-' + slug(taskId) + '-' + suffix;
}

// Creates <baseDir>/<taskId> as a worktree of repoDir on a fresh branch from HEAD.
// Returns {dir, branch}. Throws with git's message when repoDir is not a git
// repository or the worktree cannot be made — the caller marks the task blocked
// instead of falling back to the user's tree.
function createWorktree({repoDir, baseDir, taskId, branch, runGit = defaultRunGit}) {
  const dir = path.join(baseDir, slug(taskId));
  const br = branch || branchNameFor(taskId);
  fs.mkdirSync(baseDir, {recursive: true});
  pool.createWorktree({repoDir, dir, branch: br, runGit});
  return {dir, branch: br};
}

// Removes the worktree folder (the branch is KEPT: the morning report names it
// and the user merges it by hand). force because a finished run leaves edits in
// the worktree — they live on in the branch only if the runner committed them;
// uncommitted leftovers are the runner's to report, never silently the user's.
function removeWorktree({repoDir, dir, runGit = defaultRunGit}) {
  return pool.removeWorktree({repoDir, dir, runGit});
}

function isGitRepo({repoDir, runGit = defaultRunGit}) {
  return pool.isGitRepo({repoDir, runGit});
}

// Snapshots whatever the run left in the worktree onto its branch, so removing
// the folder afterwards loses nothing. Returns {committed, files} — committed
// false (and no error) when the tree is clean. The commit is made with a muser
// identity passed by -c flags, never by changing the user's git config.
function commitWorktree({dir, message, runGit = defaultRunGit}) {
  // --untracked-files=all: plain porcelain collapses an untracked FOLDER
  // into one '?? newdir/' line, which both miscounts the files and hides
  // a secret file inside it from the check below (features-debug #32).
  const st = runGit(['status', '--porcelain', '--untracked-files=all'], dir);
  if (!st.ok) throw new Error('git status failed: ' + String(st.stderr || '').trim().slice(0, 300));
  const files = st.stdout.split(/\r?\n/).filter(Boolean).length;
  if (!files) return {committed: false, files: 0, sensitive: 0};
  const add = runGit(['add', '-A'], dir);
  if (!add.ok) throw new Error('git add failed: ' + String(add.stderr || '').trim().slice(0, 300));
  // Secret-shaped files a run may have created are never committed onto the
  // branch (common rule: secrets stay out of every record). They stay in the
  // worktree folder, which the caller then keeps instead of removing.
  let sensitive = [];
  try {
    const {isSensitivePath} = require('../tools');
    sensitive = st.stdout.split(/\r?\n/).filter(Boolean).map(l => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')).filter(p => { try { return isSensitivePath(p) || isSensitivePath(path.join(dir, p)); } catch { return false; } });
    if (sensitive.length) runGit(['reset', '--quiet', '--', ...sensitive], dir);
  } catch { sensitive = []; }
  if (sensitive.length >= files) return {committed: false, files: 0, sensitive: sensitive.length};
  const ci = runGit(['-c', 'user.name=muser overnight', '-c', 'user.email=overnight@localhost', 'commit', '-m', String(message || 'muser overnight').slice(0, 200)], dir);
  if (!ci.ok) throw new Error('git commit failed: ' + String(ci.stderr || ci.stdout || '').trim().slice(0, 300));
  return {committed: true, files: files - sensitive.length, sensitive: sensitive.length};
}

module.exports = {createWorktree, removeWorktree, commitWorktree, isGitRepo, branchNameFor, slug, defaultRunGit};
