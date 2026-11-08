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
// A mode as people type it, for /mode and --mode alike: any case and the common words.
const MODE_WORDS = {auto: 'auto-edit', autoedit: 'auto-edit', edit: 'auto-edit', readonly: 'plan', 'read-only': 'plan', read: 'plan', ask: 'default', yolo: 'bypass'};
function modeFrom(word) { const w = String(word || '').trim().toLowerCase(); const m = MODE_WORDS[w] || w; return MODES.includes(m) ? m : null; }
const LABELS = {
  'default': '毎回確認', 'auto-edit': '編集は自動', 'plan': '読み取り専用 (plan)', 'bypass': 'すべて自動 (bypass)',
};

function tokensOf(command) {
  const c = String(command || '').trim();
  if (!c) return null;
  // U+2028/U+2029 are line terminators in PowerShell's grammar too (third
  // audit f1, unconfirmed there): a separator the shells honour must never
  // be mere whitespace to this screen, or a second command hides behind a
  // read-only first one.
  if (/[\r\n\u2028\u2029]/.test(c)) return null;
  // Shell metacharacters and PowerShell syntax: | ; & > < ` $ ( ) { } # quotes [ ]
  if (/[|;&><`$(){}#"'\[\]]/.test(c)) return null;
  return c.split(/\s+/);
}

// A program's bare name for SCREEN matching (wave7-1): path and extension
// dropped, drive-relative spelling (C:git.exe) unwound, lowercased — so
// `git.exe`, `.\\git.exe` and `C:git.exe` are `git` to the content / secret /
// config screens, and `rg.exe` is `rg`. This is only how screens recognise a
// program; the alwaysKey identity keeps the spelling exactly as wave5 left
// it (a git.bat on PATH is still not git.exe there).
function programBase(token) {
  let s = String(token || '').toLowerCase().split(/[\\/]/).pop() || '';
  s = s.replace(/^[a-z]:/, '').replace(/\.(exe|cmd|bat|ps1)$/, '');
  return s;
}

// Tokens for SCREEN use only (wave7-5). tokensOf fails closed for the
// read-only allowlist, but its null was read by the screens as "no danger"
// (fail-open): a quote or a `#` anywhere — `git grep "pat" -Oless`,
// `git log --ext-diff #x` — switched every screen off while a remembered
// key still covered the command. For screening, fall back to a lenient
// split of the raw text that treats quotes, `#` and the other shell
// delimiters as mere separators, so the flags and paths the shell would
// act on are still scanned. Lenient tokens never ALLOW anything: they are
// consumed only by screens that can downgrade a command to ask.
function screenTokens(command) {
  const strict = tokensOf(command);
  if (strict) return strict;
  const c = String(command || '').trim();
  if (!c) return [];
  return c.split(/[\s"'`#\[\]();|&<>$\{\}]+/).filter(Boolean);
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
        // Consume a separate value only when it does not look like a flag.
        // Several of these flags take an OPTIONAL value (--color, --porcelain,
        // --dirty, --short), and git itself treats a following --flag as a new
        // flag for those; swallowing it here hid it from validation, so
        // `git grep --color --open-files-in-pager=…` passed as read-only while
        // handing the output to a pager program. A value that starts with '-'
        // must use the --name=value form, where it is checked as a value.
        if (eq < 0 && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
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
    boolLong: ['oneline', 'graph', 'all', 'decorate', 'stat', 'patch', 'cc', 'summary', 'name-only', 'name-status', 'abbrev-commit', 'no-merges', 'merges', 'first-parent', 'follow', 'fixed-strings', 'extended-regexp', 'basic-regexp', 'perl-regexp', 'invert-grep', 'color', 'no-color', 'source', 'full-history', 'simplify-by-decoration', 'parents', 'children', 'left-right', 'cherry', 'cherry-pick', 'walk-reflogs', 'reflog', 'no-patch', 'raw', 'numstat', 'shortstat', 'check', 'exit-code'],
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
    // No --contents: it prints the named file's contents as the blamed text,
    // which is an arbitrary-file read wearing a read-only subcommand (audit #211).
    boolLong: ['line-porcelain', 'porcelain', 'incremental', 'show-name', 'show-number', 'show-email', 'show-stats', 'root', 'reverse', 'first-parent'],
    valueLong: ['date', 'abbrev', 'ignore-rev', 'ignore-revs-file', 'color-lines', 'color-by-age'],
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
    // Only listing remotes: bare, -v/--verbose, or `show -n` of one name.
    // Plain `show <name>` contacts the remote (ls-remote), which runs the
    // repo config's core.sshCommand and credential helpers — code execution
    // from repo config, like the helpers gitConfigRuns guards against — so
    // only the -n form, which never contacts the remote, is read-only.
    if (args.length === 0) return true;
    if (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) return true;
    if (args[0] === 'show') {
      const rest = args.slice(1);
      return rest.includes('-n') && rest.filter(a => a !== '-n').length <= 1 && !rest.some(a => a.startsWith('-') && a !== '-n');
    }
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
// Shell syntax that chains, redirects or runs more: a remembered "npm test" let
// `npm test && Remove-Item -Recurse …` through (2026-11-01), so such commands are never remembered.
const SHELL_SYNTAX = /[|;&<>`$(){}\r\n\u2028\u2029]/;
// Programs that run whatever their arguments say; remembering one would remember everything.
const RUNS_ANYTHING = new Set(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'wsl', 'iex', 'invoke-expression', 'start-process', 'saps', 'start', 'node', 'deno', 'bun', 'python', 'python3', 'py', 'ruby', 'perl', 'cscript', 'wscript', 'mshta', 'rundll32', 'regsvr32', 'npx', 'pnpx', 'bunx', 'call']);
// Dispatcher verbs: the word after the program names only a family, and the NEXT
// word is what actually runs (`npm run <script>`, `npm exec <pkg>`, `docker run
// <image>`, `yarn dlx <pkg>`). An alwaysKey for one of these must name that third
// word too, or remembering one script remembers them all (audit #210).
const DISPATCH_VERBS = new Set(['run', 'exec', 'x', 'dlx']);
// Programs that really ship as .cmd/.bat/.ps1 shims on Windows (the npm
// family): for these, and only these, the extension is not part of the
// alwaysKey — npm.cmd IS npm. Every other program keeps its extension in
// the key: git has no .bat/.ps1 shim, so a git.bat found on PATH or planted
// in a repo is a different file from git.exe and must not inherit its
// remembered key (wave5-C).
const SHIM_PROGRAMS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'pnpx']);
// Privilege / launcher wrappers: whatever word follows one of these is a
// command in its own right, not this program's subcommand (wave7-2).
const WRAPPER_PROGRAMS = new Set(['sudo', 'doas', 'time', 'env']);
// Long flags that hand work to another program or name an output file:
// --ext-diff / --textconv run a helper, --output writes a file, rg's --pre /
// --pre-glob run a preprocessor per file, --open-files-in-pager / --pager /
// --paginate hand the output to a pager program, --hostname-bin names a
// helper binary. A command carrying one is never covered by a remembered
// key (wave5-C): the benign form that was remembered did not carry it, and
// the flag changes what the command DOES, not just what it prints. The set
// is deliberately narrow — ordinary value flags (--format, --depth, …) are
// not here.
const EXEC_OR_WRITE_LONG = new Set(['ext-diff', 'external-diff', 'textconv', 'output', 'output-file', 'pre', 'pre-glob', 'open-files-in-pager', 'pager', 'paginate', 'hostname-bin']);
function commandRunsOrWritesViaFlag(command) {
  const tokens = screenTokens(command);
  if (!tokens.length) return false;
  const headBase = programBase(tokens[0]);
  const isGit = headBase === 'git';
  const isGitGrep = isGit && gitSubcommand(command) === 'grep';
  // Git's parse-options accepts an unambiguous ABBREVIATION of a long flag
  // (wave7-3): `git grep --open=more` and `--textc` really run the pager /
  // textconv helper, so for git commands a dangerous flag's prefix counts
  // too. An exact known flag is not an abbreviation — git grep's `--text`
  // is --text itself, not a shortened --textconv — so exact spec names are
  // exempt (the dangerous ones are caught by the exact check first).
  const gitKnownLong = new Set();
  if (isGit) for (const spec of Object.values(GIT_SPECS)) for (const n of [...(spec.boolLong || []), ...(spec.valueLong || [])]) gitKnownLong.add(n);
  const isGitAbbrevOfExecFlag = (name) => isGit && name.length >= 2 && !gitKnownLong.has(name) && [...EXEC_OR_WRITE_LONG].some(d => d.length > name.length && d.startsWith(name));
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--') break; // what follows is positional, not this command's flags
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = (eq >= 0 ? tok.slice(2, eq) : tok.slice(2)).toLowerCase();
      if (EXEC_OR_WRITE_LONG.has(name)) return true;
      if (isGitAbbrevOfExecFlag(name)) return true;
      continue;
    }
    // git grep's -O is --open-files-in-pager in short form, alone (-O),
    // clustered (-nO) or with its value attached (-Oless).
    if (isGitGrep && /^-[A-Za-z]*O/.test(tok)) return true;
  }
  return false;
}

// The "don't ask again" key, or null when this call must not be remembered.
function alwaysKey(kind, params, command) {
  if (kind === 'edit') return 'edit';
  if (kind === 'mcp') return 'mcp:' + command;
  if (kind === 'exec') {
    const text = String(params?.command || command || '').trim();
    if (!text || SHELL_SYNTAX.test(text)) return null;
    // A flag that runs a helper or writes a file (see EXEC_OR_WRITE_LONG)
    // is never remembered: approving `git log` must not pre-approve
    // `git log --ext-diff`, and approving the flagged form itself must not
    // store a key a later flagged form could match (wave5-C).
    if (commandRunsOrWritesViaFlag(text)) return null;
    const parts = text.split(/\s+/);
    // A program that runs anything is never remembered, under any spelling
    // (deep audit c22 #5): plain, with an extension (`powershell.exe`), as
    // a path (`.\\powershell.exe …`) or drive-relative (`C:powershell.exe …`).
    // This detection strips the extension for every program; the KEY below
    // does not — see SHIM_PROGRAMS.
    const rawFirst = parts[0].toLowerCase();
    const firstBase = rawFirst.split(/[\\/]/).pop().replace(/^[a-z]:/, '').replace(/\.(exe|cmd|bat|ps1)$/, '');
    if (RUNS_ANYTHING.has(firstBase)) return null;
    // Wrappers and env assignments in front (wave7-2/-6): the second word
    // is then not a subcommand of the first, it is a whole other command —
    // a two-word key for `sudo git` covered `sudo git push` and
    // `sudo npm install` alike, and `FOO=bar git` collapsed the same way.
    // Such a command is never remembered at all.
    if (WRAPPER_PROGRAMS.has(firstBase)) return null;
    if (/^[a-z_][a-z0-9_]*=/.test(rawFirst)) return null;
    const first = SHIM_PROGRAMS.has(firstBase) ? rawFirst.replace(/\.(exe|cmd|bat|ps1)$/, '') : rawFirst;
    // The program and a plain subcommand word (`npm ls`, `git status`), so remembering one never
    // remembers `npm exec` / `git push`. With a flag or path in its place (`git -C x push`), the
    // subcommand cannot be told, and the call is not remembered at all.
    if (parts.length === 1) return 'exec:' + first;
    if (!/^[a-z][a-z0-9_-]*$/i.test(parts[1])) return null;
    const second = parts[1].toLowerCase();
    if (DISPATCH_VERBS.has(second)) {
      const third = (parts[2] || '').toLowerCase();
      if (!/^[a-z0-9][a-z0-9@:._/-]*$/.test(third)) return null;
      return `exec:${first} ${second} ${third}`;
    }
    return `exec:${first} ${second}`;
  }
  return null;
}

// Where a path really leads, with junctions/symlinks resolved (tools.js's
// realOf, which resolves the deepest part that exists). Path checks that stay
// lexical are escaped by an in-project junction pointing at ~/.muser, .git or
// another project (deep audit H11).
function realPathOf(p) {
  try { return require('./tools').realOf(p); } catch {}
  try { return require('node:fs').realpathSync.native(String(p)); } catch { return require('node:path').resolve(String(p)); }
}
function isInsideDir(dir, p) {
  const path = require('node:path');
  const rel = path.relative(String(dir), String(p));
  return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
}

// Repository config can make a read-only git command run a program: core.fsmonitor on `git status`
// ran a planted command (2026-11-01), and so can external diff drivers, textconv, filters and
// pagers. Before a git read goes through unasked, the repo's own config (with its includes) is
// checked; the user's global config is theirs and trusted. Only keys the allowed read commands
// (status, log, diff, show, blame, ls-files, grep …) act on: hooks, ssh, editors and credentials
// never run for them, and husky's core.hooksPath or a deploy key's core.sshCommand made every git
// read in such a repo ask (and plan mode refuse it). Includes are listed with their contents.
const GIT_RUNS = /^(core\.(fsmonitor|pager)|diff\.external|(diff|merge)\.[^=]*\.(command|textconv|driver)|filter\.[^=]*\.(clean|smudge|process)|pager\.|gpg\.)/i;
// The only filter.lfs values `git lfs install --local` writes. The exemption
// must match the WHOLE value git will run through a shell: a prefix match let
// `git-lfs clean -- %f && evil` through (deep audit C2).
const LFS_SAFE = new Set(['git-lfs filter-process', 'git-lfs clean -- %f', 'git-lfs smudge -- %f']);
function gitConfigRuns(configText) {
  const text = String(configText || '');
  const entries = [];
  if (text.includes('\0')) {
    // `git config --list -z` form (what repoGitConfig returns): entries are
    // NUL-separated `key\nvalue`, so a value's own newlines survive parsing
    // instead of being mistaken for the next entry.
    for (const e of text.split('\0')) {
      if (!e) continue;
      const nl = e.indexOf('\n'), eq = e.indexOf('=');
      if (nl >= 0) entries.push([e.slice(0, nl).trim(), e.slice(nl + 1)]);
      else if (eq >= 0) entries.push([e.slice(0, eq).trim(), e.slice(eq + 1)]);
      else entries.push([e.trim(), '']);
    }
  } else {
    // Line form (key=value per line). A line that is not a plausible config
    // entry is the continuation of a multi-line value: when the entry it
    // continues is a running key, that value is not the exempt one-liner it
    // looked like on its first line, so it counts as running.
    let prevRuns = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const eq = line.indexOf('=');
      const key = (eq < 0 ? line : line.slice(0, eq)).trim();
      const looksKey = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key);
      if (!looksKey) { if (prevRuns) return true; continue; }
      entries.push([key, eq < 0 ? '' : line.slice(eq + 1).trim()]);
      prevRuns = GIT_RUNS.test(key) || /^extensions\.worktreeconfig$/i.test(key);
    }
  }
  for (const [key, rawValue] of entries) {
    const value = String(rawValue).trim();
    // Per-worktree config is enumerated separately (below); its mere
    // enablement is the danger signal, because it moves running keys into a
    // file a --local listing never showed (deep audit C3).
    if (/^extensions\.worktreeconfig$/i.test(key)) { if (/^(true|yes|on|1)$/i.test(value)) return true; continue; }
    if (!key || !GIT_RUNS.test(key)) continue;
    if (/[\r\n]/.test(rawValue)) return true; // a multi-line value is never the exempt form
    if (/^core\.fsmonitor$/i.test(key) && /^(true|false|0|1|yes|no|on|off)?$/i.test(value)) continue; // the built-in daemon, or off
    if (/^filter\.lfs\./i.test(key) && LFS_SAFE.has(value)) continue; // `git lfs install --local`
    return true;
  }
  return false;
}
function repoGitConfig(command, cwd) {
  // Same -C / --git-dir / --work-tree as the command, so it is the same repository.
  const tokens = screenTokens(command), pre = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') { pre.push(t, tokens[++i]); continue; }
    if (/^--(git-dir|work-tree|namespace)=/.test(t)) { pre.push(t); continue; }
    if (t.startsWith('-')) continue;
    break;
  }
  const {spawnSync} = require('node:child_process');
  const opts = {cwd, encoding: 'utf8', windowsHide: true, timeout: 5000};
  // -z keeps multi-line values inside their entry (see gitConfigRuns).
  const r = spawnSync('git', [...pre, 'config', '--local', '--includes', '--list', '-z'], opts);
  if (r.error) return null;
  if (!(r.status === 0 || r.status === 1)) return null; // 1: no repo config (or not a repo)
  let out = r.stdout || '';
  // Per-worktree config (.git/config.worktree) is not part of --local: list it
  // too, or a core.fsmonitor planted there is never inspected (deep audit C3).
  // Its failure (worktree config not enabled, no such file) is not fatal.
  const w = spawnSync('git', [...pre, 'config', '--worktree', '--includes', '--list', '-z'], opts);
  if (!w.error && (w.status === 0 || w.status === 1) && w.stdout) out += (out && !out.endsWith('\0') ? '\0' : '') + w.stdout;
  return out;
}

// code.read / code.grep refuse secrets, but a read-only `rg -e . ~/.ssh` (or `rg --hidden` from the
// home folder, or `git grep --no-index`) ran unasked and printed a private key to Muse. Such a
// command is not counted as read-only: it asks. Hidden files (.ssh, .env, .npmrc …) are skipped by
// rg unless a flag turns that off, and any path in the command is checked where it really leads.
const RG_UNHIDE = /^(--hidden|--no-ignore\S*|--follow|--unrestricted|-[a-zA-Z]*[uL][a-zA-Z]*)$/;
// Names a glob pathspec must never be able to expand to (third audit C1):
// stripping the wildcards from `credential*` leaves `credential`, which is
// not itself a sensitive name, yet the glob matches credentials.json.
const SENSITIVE_BASENAMES = (() => {
  const names = new Set(['.env', '.env.local', '.env.production', '.env.development', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_xmss', '.netrc', '_netrc', 'web.enc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.git-credentials', '.credentials.json', 'auth.json', 'logins.json', '.secrets', 'credentials', 'secret', 'secrets', 'private.key', 'key.pem', 'cert.pem']);
  for (const b of ['credentials', 'credential', 'secret', 'secrets']) for (const e of ['json', 'yaml', 'yml', 'toml', 'env', 'ini', 'xml', 'txt', 'csv']) names.add(b + '.' + e);
  for (const e of ['pem', 'key', 'p12', 'pfx', 'ppk', 'jks', 'keystore', 'kdbx']) names.add('file.' + e);
  return [...names];
})();
const SENSITIVE_SAMPLE_PATHS = ['.ssh/id_rsa', '.aws/credentials', '.gnupg/private.key', '.muser/permissions.json', '.muser/mcp.json'];
function globMatch(pat, str) {
  const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(str);
}
function globCouldMatchSensitive(pattern) {
  const pat = String(pattern).replace(/\\/g, '/');
  const segments = pat.split('/').filter(Boolean);
  const basePat = segments[segments.length - 1] || pat;
  for (const n of SENSITIVE_BASENAMES) if (globMatch(basePat, n)) return true;
  const segNames = [...SENSITIVE_BASENAMES, '.ssh', '.aws', '.gnupg', '.azure', '.muser'];
  for (const seg of segments) for (const n of segNames) if (globMatch(seg, n)) return true;
  for (const sp of SENSITIVE_SAMPLE_PATHS) if (globMatch(pat, sp)) return true;
  return false;
}
function readsSecrets(command, cwd) {
  const tokens = screenTokens(command), head = programBase(tokens[0]);
  if (head === 'rg' && tokens.some(t => RG_UNHIDE.test(t))) return true;
  if (head === 'git' && tokens.includes('--no-index')) return true;
  const {isSensitivePath, realOf} = require('./tools');
  const path = require('node:path'), fs = require('node:fs'), root = path.resolve(cwd), rootReal = realPathOf(root);
  // Where the subcommand's own arguments start, and whether the first
  // positional is a search PATTERN (rg / git grep) rather than a path.
  let argsStart = 1, patternTracking = head === 'rg';
  if (head === 'git') {
    let i = 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') { i += 2; continue; }
      if (/^--(?:git-dir|work-tree|namespace)=/.test(t)) { i++; continue; }
      if (t === '--no-pager' || t === '--no-replace-objects' || t === '--literal-pathspecs') { i++; continue; }
      break;
    }
    argsStart = i + 1;
    patternTracking = (tokens[i] || '').toLowerCase() === 'grep';
  }
  const checkCandidate = (v, globCheck) => {
    if (!v) return false;
    // A glob in a path position: test whether the pattern itself could match
    // a sensitive name, not just the literal text with wildcards stripped.
    if (globCheck && /[*?]/.test(v) && globCouldMatchSensitive(v)) return true;
    // A git rev:path token (HEAD:.env, HEAD~2:src/.env) names a file inside a
    // revision, not on disk: check the part after the ':' as the path it is,
    // or `git show HEAD:.env` printed a secret while looking like a plain rev.
    const candidates = [v];
    if (head === 'git' && v.includes(':')) candidates.push(v.slice(v.indexOf(':') + 1));
    // A glob pathspec (`*.env`, `**/*.key`) is expanded by git/rg, not by the
    // lexical checks below: test the name the glob stands for as well (audit #209).
    if (/[*?]/.test(v)) candidates.push(v.replace(/[*?]/g, ''));
    return candidates.some(c => {
      if (!c) return false;
      // Bare names are checked too, by the path they resolve to from cwd:
      // `rg -e . id_rsa` with the shell already inside the secret's folder
      // named no separator and used to slip past (audit #209).
      const p = path.resolve(root, c.replace(/^~(?=[\\/]|$)/, require('node:os').homedir()));
      if (isSensitivePath(p) || isSensitivePath(realOf(p)) || isSensitivePath(c)) return true;
      // A search ROOTED at a directory outside the working folder prints
      // whatever sensitive-named files live inside it — credentials.json in
      // ~/Documents is neither hidden nor git-ignored, so rg shows it. The
      // contents cannot be vetted from the command, so it asks (audit #208).
      // Containment is judged on the REAL path: a junction inside the
      // project that points outside is an outside root (deep audit H11).
      if (head === 'rg' || head === 'git') {
        try {
          if (fs.statSync(p).isDirectory() && !isInsideDir(rootReal, realOf(p))) return true;
        } catch {}
      }
      return false;
    });
  };
  let afterDash = false, pending = null, positionalCount = 0, patternFromFlag = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (pending) { const kind = pending; pending = null;
      if (kind === 'L') { const colon = t.indexOf(':'); if (colon >= 0 && checkCandidate(t.slice(colon + 1), true)) return true; if (checkCandidate(t, false)) return true; continue; }
      if (checkCandidate(t, kind === 'glob')) return true;
      continue;
    }
    if (t === '--') { afterDash = true; continue; }
    if (t.startsWith('-')) {
      const eq = t.indexOf('=');
      if (/^(-e|--regexp|-f|--file)(=|$)/.test(t)) patternFromFlag = true;
      if (eq > 0) { if (checkCandidate(t.slice(eq + 1), /^--?(glob|iglob|exclude)$/i.test(t.slice(0, eq)))) return true; continue; }
      // The attached -L<range>:<path> form (first audit #2): checkArgs reads
      // it as the -L value, but a dash-leading token was never screened, so
      // `git log -L1,100:credentials.json` slipped the path past entirely.
      const mL = /^-[A-Za-z]*L[^:]*:(.+)$/.exec(t);
      if (mL) { if (checkCandidate(mL[1], true)) return true; continue; }
      if (head === 'rg') { const mG = /^-[A-Za-z]*g(.+)$/.exec(t); if (mG && checkCandidate(mG[1], true)) return true; }
      if (t === '--glob' || t === '--iglob' || t === '--exclude' || t === '-g') pending = 'glob';
      else if (t === '-L') pending = 'L';
      else if (/^(-e|--regexp|-f|--file|--max-count|-m|-A|-B|-C|--context|--after-context|--before-context|--glob|--iglob|-g|-t|-T|-j|-r|--threads|--max-depth|--max-columns|--max-filesize|--encoding|--sort|--sortr|--type|--type-not|--color|--grep|--author|--committer|--since|--until|--after|--before|--format|--pretty|--date|--abbrev|--encoding|--diff-filter|-n|--max-count|--skip|-S|-G|-U|--unified|--context|-C|--git-dir|--work-tree|--namespace)$/.test(t)) pending = 'value';
      continue;
    }
    // A plain token: a path, a pathspec, or (for rg / git grep) the pattern.
    let globCheck = true;
    if (!afterDash && patternTracking && i >= argsStart) {
      positionalCount++;
      if (positionalCount === 1 && !patternFromFlag) globCheck = false; // the pattern itself
    }
    if (checkCandidate(t, globCheck)) return true;
  }
  return false;
}

// Bounded scan: does this directory tree hold a sensitive-named file? Used
// to judge a search root — a pattern search prints matching LINES, so a root
// that contains credentials.json leaks it even though no token names it
// (first audit #1). .git / node_modules are not searched.
function dirContainsSensitive(dir) {
  const {isSensitivePath} = require('./tools');
  const path = require('node:path'), fs = require('node:fs');
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, {withFileTypes: true}); } catch { continue; }
    for (const e of ents) {
      if (++seen > 20000) return false;
      const p = path.join(d, e.name);
      let isDir = e.isDirectory(), isFile = e.isFile();
      if (e.isSymbolicLink()) { try { const st = fs.statSync(p); isDir = st.isDirectory(); isFile = st.isFile(); } catch {} }
      if (isDir) { if (e.name !== '.git' && e.name !== 'node_modules') stack.push(p); }
      else if (isFile && (isSensitivePath(p) || isSensitivePath(realPathOf(p)))) return true;
    }
  }
  return false;
}

// Split a command's argument tokens into positionals and seen flag names,
// consuming flag values per the subcommand's spec, so a search's pattern,
// paths and pathspecs can be told apart.
function collectPositionals(args, spec) {
  const valueLong = new Set(spec.valueLong || []), valueShort = new Set(spec.valueShort || []);
  const positionals = [], flags = new Set();
  let afterDash = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (afterDash) { positionals.push({tok, afterDash: true}); continue; }
    if (tok === '--') { afterDash = true; continue; }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('='), name = (eq >= 0 ? tok.slice(2, eq) : tok.slice(2)).toLowerCase();
      flags.add(name);
      if (eq < 0 && valueLong.has(name) && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    if (tok.length > 1 && tok.startsWith('-')) {
      const letters = tok.slice(1);
      for (let j = 0; j < letters.length; j++) {
        flags.add(letters[j]);
        if (valueShort.has(letters[j])) { if (j === letters.length - 1) i++; break; }
      }
      continue;
    }
    positionals.push({tok, afterDash: false});
  }
  return {positionals, flags};
}
const RG_SPEC_FOR_PARSE = {valueLong: ['glob', 'iglob', 'type', 'type-not', 'max-count', 'max-depth', 'context', 'after-context', 'before-context', 'encoding', 'max-columns', 'max-filesize', 'sort', 'sortr', 'file', 'regexp', 'replace', 'threads', 'colors', 'path-separator'], valueShort: ['e', 'g', 'm', 'A', 'B', 'C', 't', 'T', 'E', 'f', 'j', 'r']};

// Can this read-only command print the CONTENTS of arbitrary files in a way
// readsSecrets' per-token screen cannot vet (first audit #1)? A pattern
// search over a root that holds a sensitive file, and a patch output
// (git diff / show, git log -p) with no pathspec restricting it, both can.
function dumpsArbitraryContents(command, cwd) {
  const tokens = screenTokens(command), head = programBase(tokens[0]);
  const path = require('node:path'), fs = require('node:fs');
  const root = path.resolve(cwd);
  const existingPath = (tok) => { const p = path.resolve(root, tok); try { return fs.statSync(p) ? p : null; } catch { return null; } };
  const pathRisk = (tok) => {
    const p = existingPath(tok);
    if (!p) return false;
    try { if (fs.statSync(p).isDirectory()) return dirContainsSensitive(realPathOf(p)); } catch {}
    return false;
  };
  if (head === 'rg') {
    const {positionals, flags} = collectPositionals(tokens.slice(1), RG_SPEC_FOR_PARSE);
    if (flags.has('files') || flags.has('l') || flags.has('files-with-matches') || flags.has('c') || flags.has('count')) return false; // names / counts only
    const patternFromFlag = flags.has('e') || flags.has('regexp') || flags.has('f') || flags.has('file');
    const paths = patternFromFlag ? positionals : positionals.slice(1);
    if (paths.length === 0) return dirContainsSensitive(root); // implicit root: cwd itself
    return paths.some(p => pathRisk(p.tok));
  }
  if (head !== 'git') return false;
  let i = 1, repoRoot = root;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-C') { if (tokens[i + 1]) repoRoot = path.resolve(root, tokens[i + 1]); i += 2; continue; }
    if (t === '--git-dir' || t === '--work-tree' || t === '--namespace') { i += 2; continue; }
    if (/^--(?:git-dir|work-tree|namespace)=/.test(t)) { i++; continue; }
    if (t === '--no-pager' || t === '--no-replace-objects' || t === '--literal-pathspecs') { i++; continue; }
    break;
  }
  const sub = (tokens[i] || '').toLowerCase(), args = tokens.slice(i + 1);
  const globalPre = tokens.slice(1, i); // global options (-C / --git-dir / …) for the name scans below
  if (sub === 'grep') {
    const {positionals, flags} = collectPositionals(args, GIT_SPECS.grep);
    if (flags.has('l') || flags.has('files-with-matches') || flags.has('c') || flags.has('count')) return false;
    const patternFromFlag = flags.has('e') || flags.has('f');
    const rest = patternFromFlag ? positionals : positionals.slice(1);
    const dashPaths = rest.filter(p => p.afterDash);
    if (dashPaths.length) return dashPaths.some(p => pathRisk(p.tok));
    const plainPaths = rest.filter(p => !p.afterDash && existingPath(p.tok));
    if (plainPaths.length) return plainPaths.some(p => pathRisk(p.tok));
    return dirContainsSensitive(repoRoot); // no pathspec: the whole tree
  }
  // -c / --cc print a combined diff for merges (wave7-4): patch output just
  // like -p, and the name scan below must ask git for combined names too,
  // or an evil merge's file never appears in a plain --name-only listing.
  const isCombinedLog = sub === 'log' && args.some(t => t === '--cc' || (/^-[a-z0-9]+$/i.test(t) && t.includes('c')));
  const isPatchLog = sub === 'log' && (isCombinedLog || args.some(t => t === '-p' || t === '-u' || t === '--patch' || /^--patch=/.test(t) || (/^-[a-z0-9]+$/i.test(t) && t.includes('p'))));
  if (sub === 'diff' || sub === 'show' || isPatchLog) {
    const spec = GIT_SPECS[sub] || GIT_SPECS.log;
    const {positionals, flags} = collectPositionals(args, spec);
    // Rev-set widening flags are not positionals, so they never reach revs:
    // a name scan rebuilt from revs alone silently rescans only HEAD and
    // misses commits the user's command would print (e.g. `git log -p --all`
    // reaching a secret file that lives only on a side branch). Carry the
    // allowed widening flags into the scan so it vets the same commit set.
    // Narrowing/filter flags are deliberately not carried: scanning the
    // wider set without them stays conservative.
    const revWidening = [];
    if (sub === 'log') {
      if (flags.has('all')) revWidening.push('--all');
      if (flags.has('reflog') || flags.has('walk-reflogs') || flags.has('g')) revWidening.push('--walk-reflogs');
      if (flags.has('full-history')) revWidening.push('--full-history');
    }
    const restrictions = [], revs = [];
    for (const p of positionals) {
      if (p.afterDash) { restrictions.push(p.tok); continue; }
      const colon = p.tok.indexOf(':');
      if (colon > 0 && p.tok.slice(colon + 1)) { restrictions.push(p.tok.slice(colon + 1)); continue; } // rev:path
      if (existingPath(p.tok)) { restrictions.push(p.tok); continue; } // a path, not a rev
      revs.push(p.tok);
    }
    if (restrictions.length) return restrictions.some(r => pathRisk(r));
    // No pathspec / rev:path restriction: the blanket rule (downgrade every
    // such command) broke the long-standing allowance for `git show HEAD`
    // in a repo whose HEAD touches only ordinary files (fixes-1101d SEC3).
    // Downgrade only when the output would actually include a sensitive
    // file, asking git itself for the affected names (spawnSync, like
    // repoGitConfig). A name is checked as written, resolved against the
    // repo root, and through realPathOf, as readsSecrets checks paths.
    let isSensitivePathFn = () => false;
    try { isSensitivePathFn = require('./tools').isSensitivePath; } catch {}
    const nameSensitive = (name) => {
      const resolved = path.resolve(repoRoot, name);
      return isSensitivePathFn(name) || isSensitivePathFn(resolved) || isSensitivePathFn(realPathOf(resolved));
    };
    const namesSensitive = (names) => names.some(nameSensitive);
    const {spawnSync} = require('node:child_process');
    // {stdout, stderr} on success; {unavailable} when git itself is missing;
    // {failed, stderr} on a non-zero exit; null when the scan cannot be
    // trusted (timeout, output over the byte cap, spawn failure).
    const runGit = (scanArgs) => {
      let r;
      try { r = spawnSync('git', [...globalPre, '-c', 'core.quotepath=false', ...scanArgs], {cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024}); } catch { return null; }
      if (!r) return null;
      if (r.error) return r.error.code === 'ENOENT' ? {unavailable: true} : null;
      if (r.status !== 0) return {failed: true, stderr: String(r.stderr || '')};
      return {stdout: String(r.stdout || ''), stderr: String(r.stderr || '')};
    };
    // When the name scan fails, a plain `git show <rev>` / `git diff` keeps
    // its read-only allow ONLY where the command itself would fail the same
    // way (not a repo, unknown rev) or git is unavailable, so nothing could
    // be printed either. Anything undetermined stays conservative.
    const failureDowngrades = (res, plainForm) => {
      if (!res) return true;
      if (res.unavailable) return !plainForm;
      if (plainForm && /not a git repository|unknown revision|bad revision|ambiguous argument|invalid object|not a valid object|unknown object/i.test(res.stderr || '')) return false;
      return true;
    };
    const splitNames = (out) => out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const userMaxCount = () => {
      for (let k = 0; k < args.length; k++) {
        const t = args[k];
        let m = /^--max-count=(\d+)$/.exec(t); if (m) return parseInt(m[1], 10);
        if (t === '--max-count' && /^\d+$/.test(args[k + 1] || '')) return parseInt(args[k + 1], 10);
        m = /^-n(\d+)$/.exec(t); if (m) return parseInt(m[1], 10);
        if (t === '-n' && /^\d+$/.test(args[k + 1] || '')) return parseInt(args[k + 1], 10);
      }
      return null;
    };
    // Names across a rev walk (git log -p, or git show of a range / several
    // revs), capped at 200 commits: one extra commit is requested as a
    // sentinel, and hitting it means later commits were never vetted, so
    // the scan counts as capped and downgrades.
    const logScanDowngrades = (revsForScan, plainForm) => {
      const cap = 200;
      const userMax = userMaxCount();
      const limit = userMax !== null && userMax <= cap ? userMax : cap + 1;
      const res = runGit(['log', '--name-only', '--pretty=format:commit-%H', `--max-count=${limit}`, ...(isCombinedLog ? ['-c'] : []), ...revWidening, ...revsForScan]);
      if (!res || res.unavailable || res.failed) return failureDowngrades(res, plainForm);
      let commits = 0; const names = [];
      for (const line of res.stdout.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith('commit-') && /^[0-9a-f]{7,64}$/i.test(line.slice(7))) { commits++; continue; }
        names.push(line);
      }
      if (commits > cap) return true;
      return namesSensitive(names);
    };
    if (sub === 'diff') {
      const cached = flags.has('cached') || flags.has('staged');
      const res = runGit(['diff', '--name-only', ...(cached ? ['--cached'] : []), ...revs]);
      if (!res || res.unavailable || res.failed) return failureDowngrades(res, true);
      return namesSensitive(splitNames(res.stdout));
    }
    if (sub === 'show') {
      if (revs.length > 1 || revs.some(r => r.includes('..'))) return logScanDowngrades(revs, true);
      const res = runGit(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', revs[0] || 'HEAD']);
      if (!res || res.unavailable || res.failed) return failureDowngrades(res, true);
      // diff-tree on a non-commit object (a blob: `git show <blob>` prints
      // its contents outright) exits 0 with an error on stderr and no
      // names: its contents cannot be vetted by name, so downgrade.
      if (res.stderr.trim()) return true;
      return namesSensitive(splitNames(res.stdout));
    }
    return logScanDowngrades(revs, false); // git log -p / -u / --patch / -c / --cc
  }
  return false;
}

// A UNC spelling of this machine's own admin shares (\\localhost\C$\…,
// \\127.0.0.1\C$\…, \\?\UNC\localhost\C$\…) names a local drive path:
// return that path, or the input unchanged for any other spelling (fourth
// audit M1). realpath keeps the UNC form, so the settings check below
// never matched it against the C: roots.
function uncLocalDrivePath(s) {
  let str = String(s).replace(/\\/g, '/');
  str = str.replace(/^\/\/[?.]\/unc\//i, '//');
  str = str.replace(/^\/\/[?.]\/(?=[a-z]:\/)/i, '');
  const m = /^\/\/([^/]+)\/([^/]+)\/(.*)$/.exec(str);
  if (!m) return s;
  const hosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '.']);
  try { hosts.add(require('node:os').hostname().toLowerCase()); } catch {}
  if (!hosts.has(m[1].toLowerCase())) return s;
  const share = /^([a-z])\$$/i.exec(m[2]);
  if (!share) return s;
  return share[1].toUpperCase() + ':/' + m[3];
}
// One path, normalized for comparison: local-UNC translated, segments as
// Windows resolves them (an ADS suffix and trailing dots/spaces stripped,
// like tools.js's winName), lowercased. A settings DIRECTORY spelled
// `muser.` / `muser ` is the settings folder (fourth audit M2), and the
// resolved path alone keeps that spelling, so both forms are compared.
function settingsNormKey(p) {
  const path = require('node:path');
  const abs = path.resolve(uncLocalDrivePath(String(p)));
  const keys = new Set();
  for (const cand of [abs, realPathOf(abs)]) {
    const segs = uncLocalDrivePath(cand).replace(/\\/g, '/').split('/').map((seg, i) => {
      if (i === 0 && /^[a-z]:$/i.test(seg)) return seg.toLowerCase();
      return seg.split(':')[0].replace(/[. ]+$/, '').toLowerCase();
    });
    keys.add(segs.join('/').replace(/\/+$/, ''));
  }
  return keys;
}

// muser's own settings: writing them could switch on bypass for a folder or add an MCP server
// that runs a program. Outside bypass such a write always asks, even in auto-edit.
function muserSettingsPath(file) {
  const os = require('node:os'), path = require('node:path');
  const roots = [path.join(os.homedir(), '.muser'), path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'muser')];
  // Judged on the real path: a symlink/junction inside the project that
  // points at the settings folder IS the settings folder (deep audit H11).
  const fKeys = settingsNormKey(String(file || ''));
  for (const r of roots) {
    const rKeys = settingsNormKey(r);
    for (const f of fKeys) for (const rk of rKeys) if (f === rk || f.startsWith(rk + '/')) return true;
  }
  // The approval store itself, wherever MUSER_PERMISSIONS_FILE moved it
  // (first audit #17): the fixed roots above never learn that address, so
  // a store relocated into the project was edited unasked in auto-edit.
  const perm = process.env.MUSER_PERMISSIONS_FILE;
  if (perm) {
    const pKeys = settingsNormKey(perm);
    for (const f of fKeys) if (pKeys.has(f)) return true;
  }
  return false;
}

// Writes under .git/ change how every later git command behaves: .git/config
// can name helper programs (see gitConfigRuns) and .git/hooks/ is code git
// runs itself. Like muser's own settings, such a write always asks outside
// bypass, even in auto-edit and even when edits were remembered.
function gitInternalPath(file) {
  if (!file) return false;
  // Segments as Windows resolves them (trailing dots/spaces stripped), on
  // both the path as written and the real path it leads to: a junction to a
  // .git folder, or `.git.` for `.git`, must not slip past (deep audit H11).
  const check = (str) => {
    const parts = String(str || '').replace(/\\/g, '/').split('/').filter(Boolean).map(s => s.toLowerCase().replace(/[. ]+$/, ''));
    return parts.some((s, idx) => s === '.git' || (idx < parts.length - 1 && /\.git$/.test(s)));
  };
  return check(String(file)) || check(realPathOf(file));
}

// Fourth audit H3: a remembered MCP key names only the tool, never its
// arguments. An MCP call whose args reference a protected path (.git/,
// ~/.muser/, a sensitive file or muser's settings) must ask even when the
// tool name was remembered — the coding tools ask for those paths outright.
function mcpArgsReferenceProtected(params) {
  let isSensitivePath = () => false;
  try { ({isSensitivePath} = require('./tools')); } catch {}
  const home = require('node:os').homedir();
  const checkString = (s) => {
    if (typeof s !== 'string' || !s) return false;
    const expanded = s.replace(/^~(?=[\\/]|$)/, home);
    for (const cand of [s, expanded]) {
      if (gitInternalPath(cand) || muserSettingsPath(cand) || isSensitivePath(cand)) return true;
      const segs = cand.replace(/\\/g, '/').split('/').map(x => x.toLowerCase());
      if (segs.includes('.muser')) return true; // a .muser segment in any arg is muser's own state
    }
    // Composite values (a command line, a JSON blob, a list in one string):
    // screen each token that looks like a path on its own.
    for (const tok of s.split(/[\s"'=,;]+/)) {
      if (!tok || !/[\\/.]/.test(tok)) continue;
      const e = tok.replace(/^~(?=[\\/]|$)/, home);
      if (gitInternalPath(tok) || gitInternalPath(e) || muserSettingsPath(e) || isSensitivePath(tok) || isSensitivePath(e)) return true;
      if (tok.replace(/\\/g, '/').split('/').map(x => x.toLowerCase()).includes('.muser')) return true;
    }
    return false;
  };
  let count = 0;
  const walk = (v, depth) => {
    if (count > 200 || depth > 6) return false;
    if (typeof v === 'string') { count++; return checkString(v); }
    if (Array.isArray(v)) return v.some(x => walk(x, depth + 1));
    if (v && typeof v === 'object') return Object.values(v).some(x => walk(x, depth + 1));
    return false;
  };
  return walk(params, 0);
}

// The git subcommand after any global options, or ''.
function gitSubcommand(command) {
  const tokens = screenTokens(command);
  if (programBase(tokens[0]) !== 'git') return '';
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-C' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') { i += 2; continue; }
    if (/^--(?:git-dir|work-tree|namespace)=/.test(t)) { i++; continue; }
    if (t === '--no-pager' || t === '--no-replace-objects' || t === '--literal-pathspecs') { i++; continue; }
    break;
  }
  return (tokens[i] || '').toLowerCase();
}
// First audit #4 (second half): one always-key covers both listing and
// mutating forms of these subcommands, so the key must never cover them —
// listing forms are read-only and pass without a key, `git config` is not
// read-only at all, and mutations must always ask on their own.
function gitKeyCannotCover(command) {
  const sub = gitSubcommand(command);
  if (sub === 'config') return true;
  if ((sub === 'remote' || sub === 'branch') && !readOnlyCommand(command)) return true;
  return false;
}

// Is this a git command, by bare program name (wave7-1)? The config screen
// in decide used to gate on /^git\b/, which path spellings (`.\\git.exe`,
// `C:git.exe`) never matched, so a planted core.pager ran unasked there.
function isGitScreenCommand(command) {
  return programBase(screenTokens(command)[0]) === 'git';
}

// gitConfig(command, cwd) -> the repo's config text (null when it cannot be read); injectable for tests.
// root: the session's working folder. A remembered command counts only when it runs inside it.
function decide({mode, kind, command, params, outside, always = new Set(), cwd = process.cwd(), root = cwd, targets = [], gitConfig = repoGitConfig}) {
  if (kind === 'read') return 'allow';
  if (mode === 'bypass') return 'allow';
  // MCP tools not annotated read-only: ask (plan mode refuses), unless allowed for the session.
  // A remembered key covers the tool name only: args that reference a
  // protected path ask regardless (fourth audit H3).
  if (kind === 'mcp') return mode === 'plan' ? 'deny' : (always.has(alwaysKey('mcp', params, command)) && !mcpArgsReferenceProtected(params)) ? 'allow' : 'ask';
  // cmd.exe expands %VAR% before the program runs, so the paths a command
  // really touches are not the ones the lexical screens vetted (deep H10).
  const execText = kind === 'exec' ? String(params?.command || '') : '';
  const cmdPercent = /^cmd(\.exe)?$/i.test(String(params?.shell || '')) && /%[A-Za-z_][A-Za-z0-9_]*%/.test(execText);
  let ro = kind === 'exec' && readOnlyCommand(params?.command);
  // A read-only command downgraded by a safety screen must ASK: it must not
  // fall through to the remembered-key check below, whose two-word key
  // cannot tell it from the benign form that was remembered (first #4).
  let downgraded = false;
  if (ro && readsSecrets(params.command, cwd)) { ro = false; downgraded = true; }
  if (ro && cmdPercent) { ro = false; downgraded = true; }
  if (ro && dumpsArbitraryContents(params.command, cwd)) { ro = false; downgraded = true; }
  if (ro && isGitScreenCommand(params.command)) {
    const config = gitConfig(params.command, cwd);
    if (config === null || gitConfigRuns(config)) { ro = false; downgraded = true; }
  }
  if (mode === 'plan') return ro ? 'allow' : 'deny';
  if (ro) return 'allow';
  if (downgraded) return 'ask';
  if (kind === 'edit' && (outside || targets.some(t => muserSettingsPath(t) || gitInternalPath(t)))) return 'ask';
  // Remembered for this folder, so only here: "npm test" allowed in one project ran another's
  // test script unasked when Muse set cwd to that project. Containment is
  // judged on real paths, so a junction into another project is not "here".
  const key = alwaysKey(kind, params);
  const here = kind !== 'exec' || isInsideDir(realPathOf(root), realPathOf(cwd));
  if (key && here && always.has(key) && !cmdPercent && !(kind === 'exec' && gitKeyCannotCover(execText))) {
    // Wave5-C: the downgrade screens above guard only the read-only path,
    // so a remembered key used to wave the same dangers through on a
    // non-read-only form: `findstr … id_rsa` under a remembered findstr,
    // or a git command in a repo whose config runs a helper. Before a key
    // allows anything, the same screens run here, plus the exec/write-flag
    // screen — a legacy key (saved before alwaysKey learned that screen)
    // must not cover `git log --ext-diff` either.
    if (kind === 'exec') {
      if (readsSecrets(params.command, cwd)) return 'ask';
      if (dumpsArbitraryContents(params.command, cwd)) return 'ask';
      if (commandRunsOrWritesViaFlag(params.command)) return 'ask';
      if (isGitScreenCommand(params.command)) {
        const config = gitConfig(params.command, cwd);
        if (config === null || gitConfigRuns(config)) return 'ask';
      }
    }
    return 'allow';
  }
  if (kind === 'edit' && mode === 'auto-edit') return 'allow';
  return 'ask';
}

module.exports = {MODES, modeFrom, LABELS, decide, alwaysKey, readOnlyCommand, gitConfigRuns, muserSettingsPath, gitInternalPath};
