'use strict';
// "Only look": the PC commands allowed while Muse is answering in the 3D body's side chat (see
// companion-link.js). An allowlist that fails closed: a command it cannot tell to be read-only is refused,
// with a reason Muse can act on. Muse's PC calls do not say which chat they come from, so desktop-api.js
// applies this to every call made while a side-chat turn is in flight.

// First words of a command that only read (cmd and PowerShell, with common aliases).
const READERS = new Set([
  // cmd
  'echo', 'dir', 'type', 'tasklist', 'where', 'findstr', 'find', 'sort', 'more', 'systeminfo', 'ver', 'whoami',
  'hostname', 'tree', 'netstat', 'ipconfig', 'chcp', 'cd', 'chdir', 'pushd', 'popd', 'set', 'date', 'time', 'vol',
  // PowerShell aliases of readers
  'gci', 'ls', 'gc', 'cat', 'gps', 'ps', 'gwmi', 'gcim', 'gp', 'gi', 'gl', 'pwd', 'select', 'sort', 'ft', 'fl', 'fw',
  'measure', 'group', 'sls', 'write', '%', '?', 'foreach', 'where', 'compare', 'diff',
  // PowerShell keywords (what they run is checked as its own segment)
  'if', 'else', 'elseif', 'for', 'while', 'try', 'catch', 'finally', 'return',
]);
// PowerShell verbs that only read; Out-/Write- only to the screen.
const READ_VERBS = new Set(['get', 'select', 'where', 'sort', 'format', 'measure', 'convertto', 'convertfrom', 'group', 'test', 'resolve', 'split', 'join', 'compare', 'foreach', 'find', 'search']);
const SCREEN_ONLY = new Set(['out-string', 'out-null', 'out-host', 'write-output', 'write-host']);
const PS_VERBS = /\b(add|approve|assert|backup|block|build|checkpoint|clear|close|compare|complete|compress|confirm|connect|convert|convertfrom|convertto|copy|debug|deny|deploy|disable|disconnect|dismount|edit|enable|enter|exit|expand|export|find|foreach|format|get|grant|group|hide|import|initialize|install|invoke|join|limit|lock|measure|merge|mount|move|new|open|optimize|out|ping|pop|protect|publish|push|read|receive|redo|register|remove|rename|repair|request|reset|resize|resolve|restart|restore|resume|revoke|save|search|select|send|set|show|skip|sort|split|start|step|stop|submit|suspend|switch|sync|tee|test|trace|unblock|undo|uninstall|unlock|unprotect|unpublish|unregister|update|use|wait|watch|where|write)-[a-z]\w*/gi;

const {t} = require('../i18n');

const why = (reason) => ({ reason });

function firstWord(segment) {
  let s = segment.trim();
  // `$x = <command>`: the command is what matters.
  const assign = /^\$[\w:.]+\s*[+\-*/]?=\s*(.*)$/s.exec(s);
  if (assign) s = assign[1].trim();
  return s;
}

// Each command position: split on separators and the starts of blocks and subexpressions, keeping what came
// before each piece (an argument list after "(" is not a command position for a quoted program).
function segments(command) {
  const parts = command.split(/(\r?\n|\|\||&&|[|;&{}()])/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) out.push({ text: parts[i], after: i > 0 ? parts[i - 1] : '' });
  return out;
}

function reviewCommand(command, depth = 0) {
  const c = String(command || '');
  if (!c.trim()) return null;
  if (depth > 3) return why(t('入れ子が深すぎるコマンド'));
  // Writing through redirection (to nul / $null is fine).
  if (/(?<![-=<])\d?>{1,2}(?!\s*(?:&[12]\b|\$null\b|nul\b))/i.test(c)) return why(t('リダイレクトでファイルに書き込む'));
  if (/\s-(?:e|en|enc|encodedcommand)\s+[a-z0-9+/=]{16,}/i.test(c)) return why(t('中身の見えないコマンド'));
  // PowerShell's call operator / dot-sourcing, and cmd starting a quoted program.
  if (/&\s*["'$]/.test(c) || /(?:^|[\s;|({])\.\s+["'$]/.test(c)) return why(t('プログラムやスクリプトの呼び出し（& や .）'));
  // Static .NET calls: only a few that read.
  const statics = c.match(/::\s*\w+/g) || [];
  for (const m of statics) {
    if (!/::\s*(Now|UtcNow|Today|GetFolderPath|GetEnvironmentVariable|GetEnvironmentVariables|MachineName|UserName|OSVersion|ProcessorCount|Is64BitOperatingSystem|GetTempPath|GetFileName|GetFileNameWithoutExtension|GetDirectoryName|GetExtension|Combine|Exists|ReadAllText|ReadAllLines|GetFiles|GetDirectories|EnumerateFiles|GetLastWriteTime|Round|Floor|Ceiling|Abs|Max|Min|Parse|TryParse|Join|Format|IsNullOrEmpty|IsNullOrWhiteSpace|GetVersionInfo|GetProcesses|GetProcessById|UTF8|Default|Unicode|ASCII)\b/i.test(m)) return why(t('読み取り以外の .NET 呼び出し（{call}）', {call: m.replace(/\s+/g, '')}));
  }
  // Instance methods fail closed too: only a small read-only allowlist may be
  // called. Anything else (.Kill(), .Delete(), .Start(), .Add(), or a method this
  // file has never heard of) might change the object it is called on. Static
  // calls ([Type]::Method()) are not matched here: they were checked above.
  const READ_METHODS = new Set(['tostring', 'gettype', 'trim', 'trimstart', 'trimend', 'tolower', 'toupper', 'tolowerinvariant', 'toupperinvariant', 'contains', 'containskey', 'containsvalue', 'startswith', 'endswith', 'substring', 'split', 'replace', 'format', 'equals', 'compareto', 'gethashcode', 'indexof', 'lastindexof', 'indexofany', 'lastindexofany', 'padleft', 'padright', 'join', 'clone', 'toarray', 'trygetvalue', 'adddays', 'addhours', 'addminutes', 'addseconds', 'addmilliseconds', 'addmonths', 'addyears', 'addticks', 'toshortdatestring', 'tolongdatestring', 'toshorttimestring', 'tolongtimestring']);
  for (const m of c.matchAll(/\.([A-Za-z_]\w*)\s*\(/g)) {
    if (!READ_METHODS.has(m[1].toLowerCase())) return why(t('読み取り以外のメソッド呼び出し（.{method}）', {method: m[1]}));
  }
  // Any PowerShell cmdlet with a verb that changes things, anywhere in the command.
  for (const m of c.match(PS_VERBS) || []) {
    const name = m.toLowerCase(), verb = name.split('-')[0];
    if (READ_VERBS.has(verb) || SCREEN_ONLY.has(name)) continue;
    if (verb === 'get' || name === 'select-string') continue;
    return why(t('読み取り以外のコマンドレット（{name}）', {name: m}));
  }
  for (const { text: segment, after } of segments(c)) {
    let s = firstWord(segment).replace(/^[@!,]+/, '').trim();
    if (!s) continue;
    // cmd /c ..., powershell -Command ...: look at what they run.
    const wrapper = /^(?:cmd(?:\.exe)?\s+\/[ck]\s+|(?:powershell|pwsh)(?:\.exe)?\s+(?:-[a-z]+(?:\s+(?!-)[^\s"']+)?\s+)*?-c(?:ommand)?\s+)(.*)$/is.exec(s);
    if (wrapper) {
      const inner = reviewCommand(wrapper[1].replace(/^["']|["']$/g, ''), depth + 1);
      if (inner) return inner;
      continue;
    }
    if (/^(?:powershell|pwsh|cmd)(?:\.exe)?\b/i.test(s)) return why(t('中身を確かめられないシェルの起動'));
    if (/^["']/.test(s)) {
      if (after === '(' || after === ')') continue; // ("Desktop"): an argument, not a program
      return why(t('引用符で書かれたプログラムの起動'));
    }
    if (/^[$\d\[\-]/.test(s)) continue; // variables, numbers, [type] casts, operators
    if (/^[a-z_][\w-]*\s*=/i.test(s)) continue; // a hashtable entry: @{n='MB';e={...}}
    const word = (/^[^\s"']+/.exec(s) || [''])[0].replace(/["']+$/, '');
    const lower = word.toLowerCase();
    if (READERS.has(lower)) {
      // `set X=Y` sets a variable, whatever X is; bare `set` / `set X` only shows.
      if (lower === 'set' && s.slice(word.length).includes('=')) return why(t('環境変数の変更（set …=…）'));
      // Bare `date` / `time` only show; with any argument they set the clock.
      if ((lower === 'date' || lower === 'time') && s.slice(word.length).trim()) return why(lower === 'date' ? t('日付の変更（date への引数）') : t('時刻の変更（time への引数）'));
      continue;
    }
    if (lower === 'reg' || lower === 'reg.exe') {
      if (/^reg(?:\.exe)?\s+query\b/i.test(s)) continue;
      return why(t('レジストリの照会（reg query）以外'));
    }
    if (lower === 'wmic' || lower === 'wmic.exe') {
      if (/\b(get|list)\b/i.test(s) && !/\b(call|delete|create|set)\b/i.test(s)) continue;
      return why(t('wmic の get / list 以外'));
    }
    const cmdlet = /^([a-z]+)-([a-z]\w*)$/i.exec(word);
    if (cmdlet && cmdlet[1].toLowerCase() === 'get') {
      // Get-* only reads, unless its own arguments run code or write a file:
      // a script block, an Invoke-* handed to it, or an output-file parameter.
      const rest = s.slice(word.length);
      if (/(?:^|\s)-(?:scriptblock|outfile|outputfile|destination|destinationpath)\b/i.test(rest)) return why(t('コード実行や書き込みにつながる引数（{word}）', {word}));
      if (/(?:^|\s)-o(?:\s|$|=)/i.test(rest)) return why(t('書き込みにつながる引数 -o（{word}）', {word}));
      if (/\bInvoke(?:-[A-Za-z]\w*)?\b/i.test(rest)) return why(t('コード実行につながる引数（{word}）', {word}));
    }
    if (cmdlet && (READ_VERBS.has(cmdlet[1].toLowerCase()) || SCREEN_ONLY.has(lower))) continue;
    return why(t('見るだけのコマンドとして知らないもの（{word}）', {word: word.slice(0, 40)}));
  }
  return null;
}

// Returns null when the call only looks, otherwise {reason}.
function reviewReadOnly(command, params = {}) {
  if (command === 'file.read' || command === 'device.health' || command === 'companion.info') return null;
  // Her own mind (reading it, or keeping something in it) changes nothing on the PC.
  if (command === 'companion.mind') return null;
  if (command === 'companion.act') {
    if (String(params.action || '') === 'say') return why(t('say（返事は自動で吹き出しに出ます）'));
    return null;
  }
  if (command === 'file.write') return why(t('ファイルへの書き込み'));
  if (command === 'system.run') return reviewCommand(params.command);
  return why(t('知らない操作（{command}）', {command: String(command).slice(0, 40)}));
}

module.exports = { reviewReadOnly, reviewCommand };
