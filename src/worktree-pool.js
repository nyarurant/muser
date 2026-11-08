'use strict';
// One git-worktree helper for the features that run work off to the side
// of the user's own working tree — race's throwaway comparison trees
// (src/race.js) and overnight's per-task branches (src/overnight/). Each
// feature branch originally grew its own copy of this machinery; this is
// the shared one both now use.
//
// The aligned semantics (the features-merge DevNote records the choices
// and their reasons):
//  - Creation is `git worktree add` from HEAD: detached when the tree is
//    disposable (race), or on a fresh branch when the branch is the
//    deliverable (overnight — the branch is KEPT at cleanup).
//  - A node_modules junction can be shared into the tree instead of a
//    copy, and is kept out of the tree's own diff via its info/exclude.
//  - Cleanup drops that junction BEFORE anything deletes the folder
//    (deleting through it would reach the shared folder), then
//    `git worktree remove --force`; if git refuses, the folder is deleted
//    plainly and `git worktree prune` forgets the registration.
//  - git is driven through an injectable runGit(argv, cwd) ->
//    {ok, stdout, stderr} (overnight's seam, kept), defaulting to a plain
//    spawnSync without a shell, so paths are never re-parsed.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function defaultRunGit(argv, cwd) {
  const r = spawnSync('git', argv, {cwd, encoding: 'utf8', windowsHide: true});
  return {ok: r.status === 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || r.error?.message || '')};
}

function isGitRepo({repoDir, runGit = defaultRunGit}) {
  try { return !!runGit(['rev-parse', '--is-inside-work-tree'], repoDir).ok; } catch { return false; }
}

// Creates `dir` as a worktree of repoDir at HEAD — on a fresh `branch`
// when one is named, detached otherwise. Returns {dir, branch} (branch is
// null for a detached tree). Throws with git's message when the worktree
// cannot be made; callers never fall back to the user's own tree.
function createWorktree({repoDir, dir, branch, runGit = defaultRunGit}) {
  fs.mkdirSync(path.dirname(dir), {recursive: true});
  const args = branch ? ['worktree', 'add', '-b', branch, dir, 'HEAD'] : ['worktree', 'add', '--detach', dir, 'HEAD'];
  const r = runGit(args, repoDir);
  if (!r.ok) throw new Error('git worktree add failed: ' + String(r.stderr || r.stdout || '').trim().slice(0, 300));
  return {dir, branch: branch || null};
}

// Shares repoDir's node_modules into the worktree by junction, and adds
// node_modules to the worktree's own info/exclude so it never shows in
// the tree's diff even in a repo that does not gitignore it. Best-effort:
// a tree without the junction is still a working tree.
function linkNodeModules({repoDir, dir, runGit = defaultRunGit}) {
  const nm = path.join(repoDir, 'node_modules'), wtNm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm) || fs.existsSync(wtNm)) return false;
  try {
    fs.symlinkSync(nm, wtNm, 'junction');
    // The exclude must land in the COMMON git dir's info/exclude: that is
    // the one git reads for every worktree of the repo. The worktree's own
    // git dir (what --git-dir answers) has an info/exclude too, but git
    // never reads it, so writing there left the junction fully visible to
    // status / add -A (features-debug #27).
    const gd = runGit(['rev-parse', '--git-common-dir'], dir);
    if (gd.ok) {
      // --git-common-dir answers relative to the worktree or absolute,
      // depending on the tree; resolve it — joining an absolute answer
      // onto the tree path would bury the exclude file inside the tree.
      const ex = path.join(path.resolve(dir, gd.stdout.trim()), 'info', 'exclude');
      fs.mkdirSync(path.dirname(ex), {recursive: true});
      fs.appendFileSync(ex, '\nnode_modules\n');
    }
    return true;
  } catch { return false; }
}

// Removes the worktree folder (a branch made at creation is KEPT — only
// the folder and its registration go). Returns whether git's own remove
// succeeded; when it refuses, the fallback (plain delete + prune) has
// already run.
function removeWorktree({repoDir, dir, runGit = defaultRunGit}) {
  if (!dir) return false;
  // Drop a node_modules junction first: deleting through it would reach
  // the shared folder.
  try { const nm = path.join(dir, 'node_modules'); if (fs.lstatSync(nm).isSymbolicLink()) fs.rmSync(nm, {force: true}); } catch {}
  const r = runGit(['worktree', 'remove', '--force', dir], repoDir);
  if (!r.ok) { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} try { runGit(['worktree', 'prune'], repoDir); } catch {} }
  return !!r.ok;
}

module.exports = {defaultRunGit, isGitRepo, createWorktree, linkNodeModules, removeWorktree};
