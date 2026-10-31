'use strict';
// Approval modes, after Claude Code's permission modes and Codex's sandbox levels.
// decide() -> 'allow' | 'ask' | 'deny'. Edits outside the working directory always ask
// (except in bypass), like Codex's workspace-write sandbox.
//
// readOnlyCommand() fails CLOSED: a command is read-only only when it matches a small
// allowlist, token by token. Anything it cannot prove read-only (unknown program,
// unknown git subcommand, unknown flag, shell syntax) is not read-only. There is no
// denylist fallback.

const MODES = ['default', 'auto-edit', 'plan', 'bypass'];
const LABELS = {
  'default': '毎回確認', 'auto-edit': '編集は自動', 'plan': '読み取り専用 (plan)', 'bypass': 'すべて自動 (bypass)',
};

function tokensOf(command) {
  const c = String(command || '').trim();
  if (!c) return null;
  if (/[\r\n]/.test(c)) return null;
  // Shell metacharacters and PowerShell syntax: | ; & > < ` $ ( ) { } # quotes [ ]
  if (/[|;&><`$(){}#"'\[\]]/.test(c)) return null;
  return c.split(/\s+/);
}

// Validate the argument tokens of one command against a flag spec.
// spec: {boolLong, valueLong, boolShort, valueShort, positional, numericDash}
// Long flags: --name or --name=value (valueLong may also take the next token).
// Short flags: clusters like -sn; a valueShort letter swallows the rest of its
// token, or the next token when nothing follows it. Unknown flags fail.
function checkArgs(args, spec) {
  const boolLong = new Set(spec.boolLong || []);
  const valueLong = new Set(spec.valueLong || []);
  const boolShort = new Set(spec.boolShort || []);
  const valueShort = new Set(spec.valueShort || []);
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (endOfFlags) {
      if (!spec.positional) return false;
      continue;
    }
    if (tok === '--') { endOfFlags = true; continue; }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = (eq >= 0 ? tok.slice(2, eq) : tok.slice(2)).toLowerCase();
      if (valueLong.has(name)) {
        // Consume a separate value when one is present. A few of these flags
        // take an optional value (--porcelain, --dirty, --short), so running
        // out of tokens here is not by itself a failure.
        if (eq < 0 && i + 1 < args.length) i++;
        continue;
      }
      if (boolLong.has(name) && eq < 0) continue;
      return false;
    }
    if (tok.length > 1 && tok.startsWith('-')) {
      if (/^-\d+$/.test(tok)) { if (spec.numericDash) continue; return false; }
      const letters = tok.slice(1);
      let ok = true;
      for (let j = 0; j < letters.length; j++) {
        const ch = letters[j];
        if (boolShort.has(ch)) continue;
        if (valueShort.has(ch)) {
          if (j === letters.length - 1 && ++i >= args.length) return false;
          break; // the rest of the token (if any) is this flag's value
        }
        ok = false; break;
      }
      if (!ok) return false;
      continue;
    }
    if (!spec.positional) return false;
  }
  return true;
}

const GIT_SPECS = {
  status: {
    boolLong: ['short', 'branch', 'long', 'ahead-behind', 'show-stash', 'no-renames'],
    valueLong: ['porcelain', 'untracked-files', 'ignored', 'find-renames'],
    boolShort: ['s', 'b', 'z', 'v', 'u'],
    valueShort: [],
    positional: true,
  },
  log: {
    boolLong: ['oneline', 'graph', 'all', 'decorate', 'stat', 'patch', 'summary', 'name-only', 'name-status', 'abbrev-commit', 'no-merges', 'merges', 'first-parent', 'follow', 'fixed-strings', 'extended-regexp', 'basic-regexp', 'perl-regexp', 'invert-grep', 'color', 'no-color', 'source', 'full-history', 'simplify-by-decoration', 'parents', 'children', 'left-right', 'cherry', 'cherry-pick', 'walk-reflogs', 'reflog', 'no-patch', 'raw', 'numstat', 'shortstat', 'check', 'exit-code'],
    valueLong: ['max-count', 'skip', 'since', 'until', 'after', 'before', 'author', 'committer', 'grep', 'format', 'pretty', 'date', 'decorate-refs', 'decorate-refs-exclude', 'abbrev', 'encoding', 'diff-filter', 'max-parents', 'min-parents', 'regexp-ignore-case'],
    boolShort: ['p', 'i', 'E', 'F', 'P', 'g', 'c', 'h'],
    valueShort: ['n', 'L', 'S', 'G'],
    positional: true, numericDash: true,
  },
  diff: {
    boolLong: ['stat', 'patch', 'name-only', 'name-status', 'shortstat', 'numstat', 'summary', 'cached', 'staged', 'minimal', 'patience', 'histogram', 'word-diff', 'color-words', 'no-ext-diff', 'no-textconv', 'ignore-all-space', 'ignore-space-change', 'ignore-space-at-eol', 'ignore-cr-at-eol', 'ignore-blank-lines', 'relative', 'exit-code', 'quiet', 'raw', 'check', 'no-patch', 'full-index', 'binary', 'abbrev', 'color', 'no-color', 'find-copies-harder', 'no-renames', 'dirstat'],
    valueLong: ['unified', 'context', 'inter-hunk-context', 'src-prefix', 'dst-prefix', 'diff-algorithm', 'find-renames', 'find-copies', 'abbrev', 'word-diff-regex', 'stat-width', 'stat-name-width', 'stat-count', 'ignore-submodules', 'submodule', 'ita-invisible-in-index', 'output-indicator-new', 'output-indicator-old', 'output-indicator-context'],
    boolShort: ['p', 's', 'w', 'b', 'q', 'a', 'R', 'B', 'M', 'C', 'D'],
    valueShort: ['U', 'W'],
    positional: true,
  },
  show: {
    boolLong: ['stat', 'patch', 'name-only', 'name-status', 'shortstat', 'numstat', 'summary', 'abbrev-commit', 'oneline', 'no-patch', 'raw', 'check', 'exit-code', 'color', 'no-color', 'no-ext-diff', 'no-textconv', 'ignore-all-space', 'ignore-space-change', 'ignore-cr-at-eol', 'no-notes', 'first-parent'],
    valueLong: ['format', 'pretty', 'date', 'abbrev', 'encoding', 'notes', 'show-notes', 'unified', 'context', 'diff-algorithm', 'src-prefix', 'dst-prefix'],
    boolShort: ['p', 's', 'w', 'b', 'q', 'R'],
    valueShort: ['U', 'n'],
    positional: true, numericDash: true,
  },
  blame: {
    boolLong: ['line-porcelain', 'porcelain', 'incremental', 'show-name', 'show-number', 'show-email', 'show-stats', 'root', 'reverse', 'first-parent'],
    valueLong: ['date', 'contents', 'abbrev', 'ignore-rev', 'ignore-revs-file', 'color-lines', 'color-by-age'],
    boolShort: ['p', 'l', 't', 's', 'n', 'e', 'w', 'f', 'b'],
    valueShort: ['L', 'S', 'C', 'M'],
    positional: true,
  },
  'ls-files': {
    boolLong: ['cached', 'deleted', 'modified', 'others', 'ignored', 'stage', 'directory', 'no-empty-directory', 'unmerged', 'killed', 'exclude-standard', 'exclude-from', 'error-unmatch', 'full-name', 'recurse-submodules', 'debug', 'eol', 'deduplicate', 'empty-directory'],
    valueLong: ['exclude', 'exclude-from', 'exclude-per-directory', 'format', 'abbrev'],
    boolShort: ['c', 'd', 'm', 'o', 'i', 's', 'z', 't', 'v', 'f', 'k', 'u'],
    valueShort: ['x', 'X'],
    positional: true,
  },
  'rev-parse': {
    boolLong: ['abbrev-ref', 'show-toplevel', 'git-dir', 'absolute-git-dir', 'is-inside-work-tree', 'is-inside-git-dir', 'is-bare-repository', 'verify', 'quiet', 'symbolic', 'symbolic-full-name', 'short', 'show-prefix', 'show-cdup', 'show-superproject-working-tree', 'local-env-vars', 'flags', 'not', 'sq', 'keep-dashdash', 'short', 'disambiguate', 'pathspec-from-file'],
    valueLong: ['short', 'abbrev-ref', 'symbolic-full-name', 'disambiguate', 'git-path', 'git-common-dir', 'since', 'until', 'default', 'sq-quote', 'pathspec-file-nul'],
    boolShort: ['q', 'h'],
    valueShort: [],
    positional: true,
  },
  describe: {
    boolLong: ['tags', 'always', 'long', 'all', 'contains', 'exact-match', 'first-parent'],
    valueLong: ['abbrev', 'match', 'exclude', 'candidates', 'dirty'],
    boolShort: [],
    valueShort: [],
    positional: true,
  },
  shortlog: {
    boolLong: ['summary', 'numbered', 'email', 'all', 'no-merges', 'committer'],
    valueLong: ['format', 'date', 'after', 'before', 'since', 'until'],
    boolShort: ['s', 'n', 'e', 'c', 'w'],
    valueShort: [],
    positional: true,
  },
  grep: {
    // Deliberately no -O / --open-files-in-pager and no --pager: those hand the
    // results to an external program (a pager), which is execution, not reading.
    boolLong: ['cached', 'no-index', 'untracked', 'recurse-submodules', 'ignore-case', 'word-regexp', 'line-regexp', 'invert-match', 'line-number', 'no-line-number', 'name-only', 'files-with-matches', 'files-without-match', 'files-with-matches', 'extended-regexp', 'basic-regexp', 'fixed-strings', 'perl-regexp', 'count', 'heading', 'break', 'show-function', 'function-context', 'text', 'no-textconv', 'basic-regexp', 'quiet', 'all-match', 'threads'],
    valueLong: ['max-count', 'max-depth', 'after-context', 'before-context', 'context', 'exclude-standard', 'f', 'e', 'threads', 'color', 'groupname'],
    boolShort: ['i', 'w', 'x', 'v', 'n', 'l', 'L', 'c', 'E', 'G', 'F', 'P', 'h', 'H', 'q', 'z', 'a', 'r', 'I'],
    valueShort: ['e', 'f', 'm', 'A', 'B', 'C'],
    positional: true,
  },
  branch: {
    // Listing only: no positional name (that would create a branch) and none of
    // -d/-D/-m/-c/-f/-u/--track/... (those delete, rename, copy or retarget one).
    boolLong: ['list', 'all', 'remotes', 'verbose', 'show-current', 'no-color', 'color'],
    valueLong: [],
    boolShort: ['l', 'a', 'r', 'v'],
    valueShort: [],
    positional: false,
  },
};

function gitReadOnly(tokens) {
  let i = 1;
  // Global options before the subcommand: only a small read-only set. In
  // particular -c / --config-env are refused: `-c core.pager=...`,
  // `-c diff.external=...` and friends install helpers that run code.
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') {
      if (i + 1 >= tokens.length) return false;
      i += 2; continue;
    }
    if (/^--(?:git-dir|work-tree|namespace)=/.test(t)) { i++; continue; }
    if (t === '--no-pager' || t === '--no-replace-objects' || t === '--literal-pathspecs') { i++; continue; }
    break;
  }
  const sub = (tokens[i] || '').toLowerCase();
  const args = tokens.slice(i + 1);
  if (sub === 'remote') {
    // Only listing remotes: bare, -v/--verbose, or `show` of one name.
    if (args.length === 0) return true;
    if (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) return true;
    if (args[0] === 'show' && args.length <= 2 && !args.slice(1).some(a => a.startsWith('-'))) return true;
    return false;
  }
  const spec = GIT_SPECS[sub];
  if (!spec) return false;
  return checkArgs(args, spec);
}

function rgReadOnly(tokens) {
  if (tokens.length < 2) return false; // bare rg has nothing to search for
  // --pre / --pre-glob (run a preprocessor per file) are not in the allowlist,
  // and neither is anything else that runs a program or writes a file.
  return checkArgs(tokens.slice(1), {
    boolLong: ['ignore-case', 'smart-case', 'case-sensitive', 'fixed-strings', 'word-regexp', 'line-regexp', 'line-number', 'no-line-number', 'with-filename', 'no-filename', 'count', 'files', 'files-with-matches', 'files-without-match', 'hidden', 'no-hidden', 'no-ignore', 'follow', 'text', 'quiet', 'stats', 'trim', 'vimgrep', 'invert-match', 'multiline', 'no-heading', 'heading', 'only-matching', 'passthru', 'sort-files', 'no-messages', 'no-ignore-vcs', 'no-ignore-parent', 'no-ignore-dot', 'ignore-dot', 'require-git', 'no-require-git', 'one-file-system', 'null', 'byte-offset', 'column', 'pretty', 'trace', 'debug', 'no-config', 'mmap', 'no-mmap', 'auto-hybrid-regex', 'pcre2', 'pcre2-unicode', 'unicode', 'no-unicode', 'json', 'text', 'binary', 'search-zip', 'no-search-zip'],
    valueLong: ['glob', 'iglob', 'type', 'type-not', 'max-count', 'max-depth', 'context', 'after-context', 'before-context', 'encoding', 'max-columns', 'max-filesize', 'sort', 'sortr', 'file', 'regexp', 'replace', 'threads', 'colors', 'path-separator'],
    boolShort: ['i', 's', 'F', 'w', 'x', 'n', 'N', 'H', 'h', 'l', 'c', 'v', 'q', 'L', 'u', 'z', 'a', 'S', 'o', 'b', 'j'],
    valueShort: ['e', 'g', 'm', 'A', 'B', 'C', 't', 'T', 'E', 'f', 'j', 'r'],
    positional: true,
  });
}

function npmReadOnly(tokens) {
  const sub = (tokens[1] || '').toLowerCase();
  if (!['ls', 'view', 'outdated'].includes(sub)) return false;
  return checkArgs(tokens.slice(2), {
    boolLong: ['json', 'global', 'long', 'parseable', 'prod', 'production', 'dev', 'only', 'link', 'all', 'unicode', 'no-unicode'],
    valueLong: ['depth', 'only', 'prefix', 'registry'],
    boolShort: ['g', 'l'],
    valueShort: [],
    positional: true,
  });
}

function readOnlyCommand(command) {
  const tokens = tokensOf(command);
  if (!tokens || tokens.length === 0) return false;
  const head = tokens[0].toLowerCase();
  if (head === 'git') return gitReadOnly(tokens);
  if (head === 'rg') return rgReadOnly(tokens);
  if (head === 'npm') return npmReadOnly(tokens);
  if (head === 'node') return tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-v');
  if (head === 'python' || head === 'python3') return tokens.length === 2 && (tokens[1] === '--version' || tokens[1] === '-V');
  return false;
}
function alwaysKey(kind, params, command) {
  if (kind === 'edit') return 'edit';
  if (kind === 'mcp') return 'mcp:' + command;
  if (kind === 'exec') {
    const parts = String(params?.command || command || '').trim().split(/\s+/).filter(Boolean);
    const first = (parts[0] || '').toLowerCase();
    if (!first) return 'exec:';
    // Include a plain subcommand word, so remembering `npm ls` / `git status`
    // never also remembers `npm exec` / `git push`. Flags, paths, values and
    // anything with punctuation are not subcommands and do not narrow the key.
    const second = parts[1] || '';
    return /^[a-z][a-z0-9_-]*$/i.test(second) ? `exec:${first} ${second.toLowerCase()}` : `exec:${first}`;
  }
  return null;
}

function decide({mode, kind, command, params, outside, always = new Set()}) {
  if (kind === 'read') return 'allow';
  if (mode === 'bypass') return 'allow';
  // MCP tools not annotated read-only: ask (plan mode refuses), unless allowed for the session.
  if (kind === 'mcp') return mode === 'plan' ? 'deny' : always.has(alwaysKey('mcp', params, command)) ? 'allow' : 'ask';
  const ro = kind === 'exec' && readOnlyCommand(params?.command);
  if (mode === 'plan') return ro ? 'allow' : 'deny';
  if (ro) return 'allow';
  if (kind === 'edit' && outside) return 'ask';
  if (always.has(alwaysKey(kind, params))) return 'allow';
  if (kind === 'edit' && mode === 'auto-edit') return 'allow';
  return 'ask';
}

module.exports = {MODES, LABELS, decide, alwaysKey, readOnlyCommand};
