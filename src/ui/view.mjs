// The Ink view. Finished entries go through <Static> (written once into scrollback, never
// redrawn); the live part below is diffed line by line (incrementalRendering), so streaming,
// spinners and typing do not flicker. The caret is placed with useCursor so IME composes in place.
import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {render, Box, Text, Static, useInput, usePaste, useCursor, useBoxMetrics, useWindowSize} from 'ink';
import {createRequire} from 'node:module';
import path from 'node:path';
import {Controller, COMMANDS} from './controller.mjs';
import {createMd} from './md.mjs';
import {sanitizeEmbeds} from './sanitize.mjs';
const require = createRequire(import.meta.url);
const {c, width, truncate, pad} = require('../tui/term.js');
const {logo} = require('../tui/logo.js');
const {LABELS} = require('../policy.js');
const {fragmentAt: mentionAt, complete: mentionComplete, listDiag: mentionDiag} = require('../mentions.js');
const {t} = require('../i18n.js');

const h = React.createElement;
const ACCENT = '#b4a0ff', DIM = '#5f5f69', GRAY = '#8c8c96';
const SPIN = ['✻', '✽', '✶', '✳', '✢', '·', '✢', '✳', '✶', '✽'];
const TITLES = {'shell.output': 'Output', 'shell.kill': 'Kill', 'shell.list': 'Shells', 'code.read': 'Read', 'code.grep': 'Search', 'code.glob': 'Glob', 'code.edit': 'Update', 'code.write': 'Write', 'code.apply_patch': 'Patch', 'todo.write': 'Todo', 'skill.read': 'Skill'};
const title = call => call.user ? '! ' + (call.params?.shell === 'cmd' ? 'Cmd' : 'PowerShell') : call.kind === 'agent' ? (call.command === 'agent.spawn' ? 'Agent' : 'Wait') : call.kind === 'mcp' ? 'MCP' : call.command === 'system.run' ? (call.params?.shell === 'cmd' ? 'Cmd' : 'PowerShell') : call.command === 'code.write' && call.view?.created ? 'Create' : TITLES[call.command] || call.command;
const elapsed = ms => { const s = Math.floor(ms / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; };
const T = (props, ...kids) => h(Text, props, ...kids);
const Line = ({children, ...p}) => h(Text, {wrap: 'truncate-end', ...p}, children);

// ---------- pieces ----------
function Row({prefix, text, code}) {
  // Opt-in: MUSER_CODE_WRAP=1 wraps long code/table rows instead of truncating them (default unchanged).
  const wrap = code && process.env.MUSER_CODE_WRAP !== '1' ? 'truncate-end' : 'wrap';
  return h(Box, null, h(Text, null, prefix), h(Box, {flexShrink: 1}, h(Text, {wrap}, text || ' ')));
}
function Md({rows, first}) {
  return h(Box, {flexDirection: 'column'}, rows.map((r, i) => h(Row, {key: i, prefix: (first && i === 0 ? '⏺ ' : '  ') + r.prefix, text: r.text, code: r.code})));
}
function todoLine(t) {
  if (t.status === 'completed') return c.faint('☒ ' + c.strike(t.content));
  if (t.status === 'in_progress') return c.accent('◼ ') + c.bold(t.content);
  return c.gray('☐ ') + t.content;
}
function Diff({diff, W, max = 30}) {
  const numW = Math.max(3, String(Math.max(0, ...diff.map(d => d.n || 0))).length), bodyW = W - numW - 12;
  const lines = diff.slice(0, max).map((d, i) => {
    if (d.t === '…') return h(Line, {key: i, color: DIM}, '      ' + ' '.repeat(numW) + ' ⋮');
    const num = String(d.n).padStart(numW), body = pad(truncate(d.l, bodyW), bodyW);
    if (d.t === '+') return h(Box, {key: i}, h(Text, null, '      '), h(Line, {backgroundColor: '#193c23', color: '#aaebaa'}, num + ' + ' + body));
    if (d.t === '-') return h(Box, {key: i}, h(Text, null, '      '), h(Line, {backgroundColor: '#461c20', color: '#f5aaaa'}, num + ' - ' + body));
    return h(Line, {key: i}, '      ' + c.faint(num) + '   ' + c.gray(truncate(d.l, bodyW)));
  });
  if (diff.length > max) lines.push(h(Line, {key: 'more', color: DIM}, '      ' + t('… ほか {n} 行', {n: diff.length - max})));
  return h(Box, {flexDirection: 'column'}, lines);
}
function Tool({call, cwd, W}) {
  const v = call.view || {}, rel = p => path.relative(cwd, p) || p;
  const res = (kid, k = 'r') => h(Box, {key: k}, h(Text, {color: DIM}, '  ⎿  '), h(Box, {flexShrink: 1}, kid));
  if (call.command === 'todo.write' && call.ok) return h(Box, {flexDirection: 'column', marginBottom: 1},
    h(Text, null, c.green('⏺ ') + c.bold('Todo')), ...(v.todos || []).map((t, i) => h(Box, {key: i}, h(Text, {color: DIM}, i ? '     ' : '  ⎿  '), h(Text, {wrap: 'wrap'}, todoLine(t)))));
  const kids = [h(Line, {key: 'h'}, (call.ok ? c.green('⏺ ') : c.red('⏺ ')) + c.bold(title(call)) + c.gray('(' + (call.summary || '') + ')'))];
  if (!call.ok) kids.push(res(h(Text, {color: call.declined ? '#f06e6e' : '#f06e6e', wrap: 'wrap'}, call.declined ? t('断りました') + (call.error.includes('declined this:') ? t('（理由を Muse に伝えました）') : '') : t('エラー: {error}', {error: call.error}))));
  else if (v.background && call.command === 'system.run') kids.push(res(h(Box, {flexDirection: 'column'}, h(Text, null, c.accent('⚙ ') + c.gray(t('バックグラウンドで実行中') + ' ') + c.bold(v.background) + c.faint('   ' + t('/bg で確認'))), ...(v.tail || []).filter(l => l.trim()).map((l, i) => h(Line, {key: i, color: DIM}, l)))));
  else if (call.command === 'shell.output') kids.push(res(h(Text, {color: GRAY}, v.background + ': ' + t('{n} 行', {n: v.lines}) + (v.running ? t('（実行中）') : t('（終了）')))));
  else if (call.command === 'shell.kill') kids.push(res(h(Text, {color: GRAY}, t('{id} を停止', {id: v.background}))));
  else if (call.command === 'shell.list') kids.push(res(h(Text, {color: GRAY}, t('{n} 個', {n: v.count}))));
  else if (call.kind === 'agent') kids.push(res(h(Text, {color: GRAY}, v.tag ? t('エージェント {tag}{type} を起動', {tag: v.tag, type: v.type ? '（' + v.type + '）' : ''}) : (v.agents || []).join(' · '))));
  else if (call.kind === 'mcp') { const lines = String(v.text || '').trim().split('\n').filter(l => l.trim()); kids.push(res(h(Box, {flexDirection: 'column'}, ...(lines.length ? lines.slice(0, 4) : [t('(結果なし)')]).map((l, i) => h(Line, {key: i, color: GRAY}, l)), ...(lines.length > 4 ? [h(Line, {key: 'm', color: DIM}, t('… ほか {n} 行', {n: lines.length - 4}))] : [])))); }
  else if (call.command === 'code.read') kids.push(res(h(Text, {color: GRAY}, t('{n} 行を読み込み', {n: v.lines}))));
  else if (call.command === 'code.grep' || call.command === 'code.glob') kids.push(res(h(Text, {color: GRAY}, call.command === 'code.grep' ? t('{n} 件ヒット', {n: v.count}) : t('{n} ファイル', {n: v.count}))));
  else if (v.files) v.files.forEach((f, i) => { kids.push(res(h(Text, null, c.bold(rel(f.path)) + '  ' + c.green('+' + f.added) + ' ' + c.red('-' + f.removed)), 'f' + i)); kids.push(h(Diff, {key: 'd' + i, diff: f.diff, W, max: 24})); });
  else if (v.diff) { let added = 0, removed = 0; for (const d of v.diff) { if (d.t === '+') added++; else if (d.t === '-') removed++; } kids.push(res(h(Text, null, c.green('+' + added) + ' ' + c.red('-' + removed)))); kids.push(h(Diff, {key: 'd', diff: v.diff, W})); }
  else if (call.command === 'system.run') {
    const tail = (v.tail || []).filter(l => l.trim());
    kids.push(res(h(Box, {flexDirection: 'column'}, ...(tail.length ? tail : [t('(出力なし)')]).map((l, i) => h(Line, {key: i, color: GRAY}, l)),
      ...(v.exit ? [h(Text, {key: 'x', color: '#f06e6e'}, v.killed === 'timeout' ? t('タイムアウト') : v.killed === 'cancelled' ? t('中断しました') : 'exit ' + v.exit)] : []))));
  }
  return h(Box, {flexDirection: 'column', marginBottom: 1}, kids);
}
// One unit that never shrinks: the row wraps whole keycaps when the labels (English) run long.
function Keycap({k, label}) { return h(Box, {flexShrink: 0}, h(Text, null, h(Text, {backgroundColor: '#2d2d34', color: ACCENT}, ' ' + k + ' '), h(Text, {color: GRAY}, ' ' + label + '   '))); }
function Banner({ctrl}) {
  const a = ctrl.agent, mark = logo();
  return h(Box, {flexDirection: 'column', marginTop: 1, marginBottom: 1},
    h(Box, null, h(Box, {flexDirection: 'column', marginLeft: 2, marginRight: 3}, h(Text, null, mark[0]), h(Text, null, mark[1])),
      h(Box, {flexDirection: 'column', flexShrink: 1},
        h(Line, null, c.bold(ctrl.museName) + c.gray(t(' と作業します')) + c.faint('   v' + ctrl.version)),
        h(Line, {color: GRAY}, a.cwd))),
    a.session.turns ? h(Box, {marginLeft: 2, marginTop: 1}, h(Line, null, c.accent('↺ ') + c.gray(t('再開: ')) + (a.session.title || a.session.id) + c.faint('   ' + t('{n} ターン', {n: a.session.turns})))) : null,
    h(Box, {marginLeft: 2, marginTop: 1, flexWrap: 'wrap'}, h(Keycap, {k: '/', label: t('コマンド')}), h(Keycap, {k: '⇧⇥', label: t('承認モード')}), h(Keycap, {k: 'esc', label: t('中断')}), h(Keycap, {k: '\\⏎', label: t('改行')}), h(Keycap, {k: 'alt+v', label: t('画像')}), h(Keycap, {k: '@', label: t('ファイル')}), h(Keycap, {k: '!', label: t('シェル')}), h(Keycap, {k: '^C^C', label: t('終了')})));
}
function Entry({e, ctrl, W}) {
  const a = ctrl.agent;
  switch (e.type) {
    case 'banner': return h(Banner, {ctrl});
    case 'user': return h(Box, {marginTop: 1, marginBottom: 1, backgroundColor: '#2d2d34', paddingX: 1, width: W, flexDirection: 'column'},
      h(Box, null, h(Text, {color: ACCENT}, '❯ '), h(Box, {flexShrink: 1}, h(Text, {wrap: 'wrap'}, e.text ? e.text.replace(/(^|\s)(@\S+)/g, (m, a, b) => a + c.accent(b)) : c.faint(t('（画像のみ）'))))),
      ...(e.files?.length ? [h(Line, {key: 'files'}, '  ' + e.files.map(f => c.accent('◇ ') + c.gray(f.ref + (f.kind === 'dir' ? '/ ' + t('{n} ファイル', {n: f.count}) : f.kind === 'file' ? ' ' + t('{n} 行', {n: f.lines}) : f.kind === 'large' ? t(' 大きいため名前のみ') : t(' (バイナリ)')))).join('   '))] : []),
      ...(e.missing?.length ? [h(Line, {key: 'miss'}, '  ' + c.yellow(t('見つからない: {list}', {list: e.missing.join(', ')})))] : []),
      ...(e.images?.length ? [h(Line, {key: 'img'}, '  ' + e.images.map((n, i) => c.accent('▣ ') + c.gray(t('画像 {i} {name}', {i: i + 1, name: n}))).join('   '))] : []));
    case 'md': return h(Md, {rows: e.rows, first: e.first});
    case 'gap': return h(Text, null, ' ');
    case 'shellout': return h(Box, {flexDirection: 'column', marginBottom: 1},
      h(Line, null, c.accent('⚙ ') + c.bold(e.id) + c.gray(e.running ? t('  実行中') : t('  終了 exit {exit}', {exit: e.exit}))),
      ...(e.lines.filter(l => l.length).length ? e.lines : [t('(出力なし)')]).map((l, i) => h(Line, {key: i, color: GRAY}, '  │ ' + l)));
    case 'agent': {
      const x = e.snap, ok = x.state === 'done', mark = ok ? c.green('✓') : x.state === 'stopped' ? c.yellow('■') : c.red('✗');
      const body = sanitizeEmbeds(String(ok ? x.result : x.error || t('停止しました')).trim()).split('\n'), md = createMd(), max = e.full ? 200 : 12;
      return h(Box, {flexDirection: 'column', marginBottom: 1, borderStyle: 'round', borderColor: ok ? '#3c5a46' : '#5a3c3c', paddingX: 1, width: W},
        h(Line, null, mark + ' ' + c.accent(c.bold(t('エージェント {tag}', {tag: x.tag}))) + c.faint(' ' + (x.type || '')) + c.gray('  ' + x.title) + c.faint('   ' + elapsed((x.ended || Date.now()) - x.started))),
        ...body.slice(0, max).map((l, i) => { const r = md.row(l); return h(Row, {key: i, prefix: r.prefix, text: r.text, code: r.code}); }),
        ...(body.length > max ? [h(Line, {key: 'more', color: DIM}, t('… ほか {n} 行（/agents で全文）', {n: body.length - max}))] : []));
    }
    case 'tool': return h(Tool, {call: e.call, cwd: a.cwd, W});
    case 'past': { // tools and Muse steps of a turn shown again on resume, compact
      const lines = [
        ...e.steps.map(s => (s.failed ? c.red('⏺ ') : c.faint('⏺ ')) + c.gray(s.title) + c.faint('  (Muse)')),
        ...e.tools.map(t => (t.ok ? c.faint('⏺ ') : c.red('⏺ ')) + c.gray(String(t.command).replace(/^code\./, '') + (t.summary ? ' ' + t.summary : '')) + (t.ok ? '' : c.red('  ' + String(t.error || '').slice(0, 60)))),
      ];
      return h(Box, {flexDirection: 'column', marginBottom: 1}, ...lines.slice(0, 6).map((l, i) => h(Line, {key: i}, l)),
        ...(lines.length > 6 ? [h(Line, {key: 'more', color: DIM}, t('  … ほか {n} 件', {n: lines.length - 6}))] : []));
    }
    case 'muse': return h(Box, {flexDirection: 'column', marginBottom: 1},
      h(Line, null, (e.step.failed ? c.red('⏺ ') : c.accent('⏺ ')) + c.bold(e.step.title) + c.faint(e.step.unfinished ? t('  (Muse · 実行中のまま)') : '  (Muse)')),
      e.step.detail ? h(Box, null, h(Text, {color: DIM}, '  ⎿  '), h(Box, {flexShrink: 1}, h(Text, {color: e.step.failed ? '#f06e6e' : GRAY, wrap: 'wrap'}, e.step.detail))) : null);
    case 'sources': return h(Box, {flexDirection: 'column', marginBottom: 1}, h(Text, {color: DIM}, t('  出典')),
      ...e.items.slice(0, 6).map((s, i) => h(Line, {key: i, color: GRAY}, '  ' + (i + 1) + '. ' + (s.label || s.domain) + c.faint('  ' + s.uri))),
      ...(e.items.length > 6 ? [h(Line, {key: 'more', color: DIM}, t('  … ほか {n} 件', {n: e.items.length - 6}))] : []));
    case 'end': return h(Box, null, e.ok ? h(Text, {color: DIM}, '  ✻ ' + elapsed(e.ms)) : h(Text, {color: e.aborted ? '#e6be64' : '#f06e6e', wrap: 'wrap'}, '  ⎿  ' + (e.aborted ? t('中断しました') : e.error)));
    case 'note': return h(Box, {flexDirection: 'column', marginBottom: 1}, e.lines.map((l, i) => h(Text, {key: i, color: GRAY, wrap: 'wrap'}, '  ' + l)));
    case 'help': return h(Box, {flexDirection: 'column', marginBottom: 1}, h(Text, {bold: true}, t('コマンド')),
      ...COMMANDS.map(([n, d]) => h(Line, {key: n}, '  ' + c.accent(pad(n, 14)) + c.gray(t(d)))), h(Text, null, ' '), h(Text, {bold: true}, t('キー')),
      h(Text, {color: GRAY, wrap: 'wrap'}, t('  enter 送信 · {bs}+enter / ctrl+j 改行 · ↑↓ 履歴 · esc 中断 · shift+tab 承認モード · tab コマンド補完 · ctrl+c ×2 終了', {bs: '\\'})));
    case 'todos': return h(Box, {flexDirection: 'column', marginBottom: 1}, e.todos.length ? e.todos.map((td, i) => h(Text, {key: i, wrap: 'wrap'}, '  ' + todoLine(td))) : h(Text, {color: GRAY}, t('  Todo はまだありません。')));
    case 'status': return h(Box, {flexDirection: 'column', marginBottom: 1}, ...[
      ['Muse', ctrl.museName + c.faint('  ' + t('ゲートウェイ') + ' ' + a.client.status)], [t('端末'), a.constructor.DEVICE + '  ' + (a.device?.connected ? c.green(t('接続中')) : c.red(t('未接続')))],
      [t('会話'), (a.session.title || t('(新規)')) + c.faint('  ' + a.session.id)], [t('場所'), a.cwd], [t('承認'), t(LABELS[a.mode])],
    ].map(([k, v]) => h(Line, {key: k}, '  ' + c.gray(pad(k, 6)) + v)));
    default: return null;
  }
}

// ---------- live area ----------
function useTick(active, ms = 100) {
  const [n, setN] = useState(0);
  useEffect(() => { if (!active) return; const t = setInterval(() => setN(x => x + 1), ms); return () => clearInterval(t); }, [active, ms]);
  return n;
}
function Working({s}) {
  const n = useTick(true);
  const what = s.status === 'waiting_for_approval' ? t('Muse 側で承認待ち（muse.ai を確認）') : s.museRunning ? s.museRunning + '…' : s.activity ? s.activity + '…' : s.stream?.partial ? t('書いています…') : t('考え中…');
  return h(Box, {marginTop: 1}, h(Text, {color: ACCENT}, SPIN[n % SPIN.length] + ' ' + what), h(Text, {color: DIM}, '  ' + elapsed(Date.now() - s.turnStart) + t(' · esc で中断')));
}
function Running({r}) {
  const n = useTick(true);
  return h(Box, {flexDirection: 'column'},
    h(Line, null, c.accent(SPIN[n % SPIN.length]) + ' ' + c.bold(title(r.call)) + c.gray('(' + (r.call.summary || '') + ')')),
    ...r.tail.map((l, i) => h(Line, {key: i, color: DIM}, '  │ ' + l)));
}
function Approval({a, ctrl, W}) {
  const call = a.call, rows = [];
  if (call.kind === 'mcp') {
    rows.push(h(Line, {key: 's'}, c.gray(t('サーバー ')) + call.mcp.server + c.gray(t('   ツール ')) + c.bold(call.mcp.tool)));
    for (const [k, v] of Object.entries(call.params || {}).slice(0, 12)) rows.push(h(Text, {key: 'p' + k, wrap: 'wrap'}, c.faint(k + ': ') + String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 400)));
  } else if (call.kind === 'exec') {
    String(call.params.command).split('\n').slice(0, 12).forEach((l, i) => rows.push(h(Text, {key: 'c' + i, wrap: 'wrap'}, l)));
    if (call.params.cwd) rows.push(h(Text, {key: 'cwd', color: GRAY}, t('場所: {cwd}', {cwd: call.params.cwd})));
  } else if (a.preview?.error) rows.push(h(Text, {key: 'e', color: '#f06e6e', wrap: 'wrap'}, t('プレビューできません: {error}', {error: a.preview.error})));
  else if (a.preview?.files) a.preview.files.forEach((f, i) => { rows.push(h(Line, {key: 'f' + i}, c.bold(path.relative(ctrl.agent.cwd, f.path) || f.path) + c.faint('  ' + f.op))); rows.push(h(Diff, {key: 'd' + i, diff: f.diff, W: W - 4, max: 14})); });
  else if (a.preview?.diff) rows.push(h(Diff, {key: 'd', diff: a.preview.diff, W: W - 4, max: Math.max(8, (process.stdout.rows || 30) - 18)}));
  if (a.outside) rows.push(h(Text, {key: 'o', color: '#e6be64'}, t('⚠ 作業フォルダーの外への書き込みです')));
  return h(Box, {flexDirection: 'column', marginTop: 1},
    h(Box, {flexDirection: 'column', borderStyle: 'round', borderColor: '#e6be64', paddingX: 1, width: W},
      h(Line, null, (call.agent && call.agent !== 'main' ? c.accent(t('[エージェント {agent}] ', {agent: call.agent})) : '') + c.yellow(c.bold(call.kind === 'exec' ? title(call) + t(' コマンド') : title(call))) + (call.kind === 'exec' ? '' : '  ' + (call.summary || ''))),
      h(Box, {flexDirection: 'column', marginY: 1}, rows),
      h(Text, {bold: true}, call.kind === 'exec' || call.kind === 'mcp' ? t('実行していい？') : t('この変更をしていい？')),
      ...a.options.map((o, i) => h(Line, {key: 'o' + i}, i === a.index ? c.accent('❯ ') + c.bold((i + 1) + '. ' + o.label) : '  ' + (i + 1) + '. ' + o.label))),
    h(Text, {color: DIM}, t('  ↑↓ で選んで enter · 1-3 · esc で断る')));
}
const MENU_ROWS = 12;
function Menu({m, W}) {
  return h(Box, {flexDirection: 'column', marginTop: 1},
    h(Box, {flexDirection: 'column', borderStyle: 'round', borderColor: ACCENT, paddingX: 1, width: W},
      h(Line, null, c.accent(c.bold(m.title)) + (m.hint ? c.faint('   ' + m.hint) : '')),
      h(Text, null, ' '),
      // The label column fits the longest label (English ones run longer), within limits. Long
      // lists (/skills) show a window of MENU_ROWS around the cursor, so the box fits the screen.
      ...((labelW => {
        const n = m.options.length, start = n <= MENU_ROWS ? 0 : Math.max(0, Math.min(m.index - Math.floor(MENU_ROWS / 2), n - MENU_ROWS)), end = Math.min(n, start + MENU_ROWS);
        return [
          ...(start > 0 ? [h(Text, {key: 'up', color: DIM}, '  ' + t('↑ ほか {n} 件', {n: start}))] : []),
          ...m.options.slice(start, end).map((o, j) => {
            const i = start + j, on = i === m.index, mark = o.mark || o.value === m.current ? c.green(' ✓') : '';
            const label = (i + 1) + '. ' + o.label, col = o.danger ? c.red : c.text;
            return h(Box, {key: i}, h(Box, {flexShrink: 0, width: 2}, h(Text, null, on ? c.accent('❯') : ' ')), h(Box, {width: labelW, flexShrink: 0}, h(Line, null, (on ? c.bold(col(label)) : col(label)) + mark)),
              h(Box, {flexShrink: 1}, h(Text, {color: on ? GRAY : DIM, wrap: 'truncate-end'}, o.desc || '')));
          }),
          ...(end < n ? [h(Text, {key: 'down', color: DIM}, '  ' + t('↓ ほか {n} 件', {n: n - end}))] : []),
        ];
      })(Math.min(Math.floor(W * 0.45), Math.max(28, ...m.options.map((o, i) => width((i + 1) + '. ' + o.label) + 4)))))),
    h(Text, {color: DIM}, t('  ↑↓ で選んで enter · 数字 · esc で閉じる')));
}
// Wraps the buffer by display cells so the caret position is exact.
function layout(text, pos, max) {
  const lines = [''], widths = [0]; let cur = {row: 0, col: 0}, i = 0;
  for (const ch of text) {
    if (i === pos) cur = {row: lines.length - 1, col: widths[widths.length - 1]};
    i += ch.length;
    if (ch === '\n') { lines.push(''); widths.push(0); continue; }
    const w = width(ch);
    if (widths[widths.length - 1] + w > max) { lines.push(''); widths.push(0); }
    lines[lines.length - 1] += ch; widths[widths.length - 1] += w;
  }
  if (i <= pos) cur = {row: lines.length - 1, col: widths[widths.length - 1]};
  return {lines, cur};
}
function Chips({list}) {
  if (!list.length) return null;
  const kb = n => n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
  return h(Box, {marginTop: 1, paddingX: 1}, ...list.map((a, i) => h(Text, {key: i}, h(Text, {backgroundColor: '#2d2d34', color: ACCENT}, ' ▣ ' + t('画像 {n}', {n: i + 1}) + ' '), h(Text, {color: GRAY}, ' ' + a.name + ' · ' + kb(a.size) + '   '))),
    h(Text, {color: DIM}, t('空の入力で backspace → 外す')));
}
function Prompt({s, W}) {
  const ref = useRef(null), box = useBoxMetrics(ref), {setCursorPosition} = useCursor();
  const reason = !!s.reasonFor, bang = !reason && s.text.startsWith('!'), head = reason ? t('理由 ') : '❯ ', inner = W - 4 - width(head);
  const {lines, cur} = layout(s.text, s.pos, inner);
  // Set during render, not in an effect: Ink applies it to the frame being written, while an
  // effect lands one frame late and leaves the caret on the previous position.
  if (box.hasMeasured) setCursorPosition({x: box.left + 2 + width(head) + cur.col, y: box.top + 1 + cur.row});
  const placeholder = reason ? t('Muse に伝えること（空なら理由なしで断る）') : s.busy ? t('Muse が作業中（送った文は次のターンになります）') : t('何をしますか？   / でコマンド');
  return h(Box, {ref, flexDirection: 'column', borderStyle: 'round', borderColor: reason || bang ? '#e6be64' : s.busy ? '#3c3c44' : DIM, paddingX: 1, width: W, marginTop: 1},
    ...lines.map((l, i) => h(Box, {key: i}, h(Text, {color: reason ? '#e6be64' : ACCENT}, i ? ' '.repeat(width(head)) : head),
      h(Text, {wrap: 'truncate-end', color: !s.text ? DIM : undefined}, !s.text && i === 0 ? placeholder : l || ' '))));
}
function Footer({s, ctrl, W}) {
  const m = s.mode, color = m === 'bypass' ? '#f06e6e' : m === 'plan' ? '#78aaf0' : m === 'auto-edit' ? ACCENT : GRAY;
  const at = mentionAt(s.text, s.pos);
  if (at) {
    const list = mentionComplete(at.fragment, ctrl.agent.cwd);
    if (!list.length) {
      const diag = mentionDiag();
      return h(Box, {paddingX: 2}, h(Text, {color: DIM}, diag.source === 'none' ? t('ファイル一覧を取得できませんでした（{error}）', {error: diag.error}) : t('一致するファイルがありません')));
    }
    const sel = ctrl.atIndex(at.fragment, list.length);
    return h(Box, {flexDirection: 'column', paddingX: 2}, list.map((f, i) => h(Line, {key: f}, (i === sel ? c.accent('◇ ' + f) : c.gray('  ' + f)) + (i === sel ? c.faint(t('   ↑↓ で選択 · enter / tab で補完')) : ''))));
  }
  if (s.text.startsWith('!')) return h(Box, {paddingX: 1}, h(Line, null, c.yellow(t('! シェルモード')) + c.faint(t('   PowerShell で今すぐ実行（Muse を通さない）· 出力は次のメッセージで Muse に渡ります'))));
  if (s.text.startsWith('/') && !s.text.includes(' ')) {
    const list = COMMANDS.filter(([n]) => n.startsWith(s.text)).slice(0, 7);
    return h(Box, {flexDirection: 'column', paddingX: 2}, list.map(([n, d], i) => h(Line, {key: n}, (i === 0 ? c.accent(pad(n, 14)) : c.gray(pad(n, 14))) + c.faint(t(d)))));
  }
  return h(Box, {paddingX: 1, width: W, justifyContent: 'space-between'},
    s.flash ? h(Text, {color: '#e6be64'}, s.flash) : h(Text, null, h(Text, {color}, (m === 'default' ? '' : '⏵⏵ ') + t(LABELS[m])), h(Text, {color: DIM}, t('   shift+tab で切替'))),
    h(Text, null, s.shells.some(x => x.running) ? h(Text, {color: ACCENT}, '⚙ ' + t('{n} 実行中', {n: s.shells.filter(x => x.running).length}) + '   ') : '', ...(s.loginNeeded ? [h(Text, {color: '#f06e6e'}, t('ログインが必要（/login）  '))] : []), h(Text, {color: s.deviceOk ? '#78cd82' : '#f06e6e'}, '● '), h(Text, {color: DIM}, ctrl.agent.constructor.DEVICE + ' · ' + ctrl.museName + (s.plan?.percentUsed != null ? ' · ' + t('週 {n}%', {n: s.plan.percentUsed}) : ''))));
}
function AgentCards({list}) {
  const n = useTick(list.some(x => x.state === 'working'));
  if (!list.length) return null;
  return h(Box, {flexDirection: 'column', marginTop: 1},
    ...list.map(x => {
      const working = x.state === 'working', mark = working ? c.accent(SPIN[(n + x.tag.length) % SPIN.length]) : x.state === 'done' ? c.green('✓') : x.state === 'stopped' ? c.yellow('■') : c.red('✗');
      const last = String(x.text || '').trim().split('\n').pop() || '';
      const what = working ? (x.lastTool ? c.gray(x.lastTool) : c.gray(t('考え中…'))) : c.faint(x.state === 'done' ? t('完了') : x.state === 'stopped' ? t('停止') : t('失敗'));
      return h(Box, {key: x.tag, flexDirection: 'column'},
        h(Line, null, mark + ' ' + c.bold(x.tag) + c.faint(' ' + (x.type || '')) + ' ' + x.title + c.faint('  ' + elapsed((working ? Date.now() : x.ended) - x.started)) + '  ' + what),
        working && last ? h(Line, {color: DIM}, '   ' + last) : null);
    }));
}
function Live({s, ctrl, W}) {
  const preview = ctrl.previewRow(), open = s.todos.filter(t => t.status !== 'completed');
  return h(Box, {flexDirection: 'column', width: W},
    preview ? h(Row, {prefix: (preview.first ? '⏺ ' : '  ') + preview.row.prefix, text: preview.row.text, code: preview.row.code}) : null,
    s.running && !s.approval ? h(Running, {r: s.running}) : null,
    s.busy && !s.running && !s.approval ? h(Working, {s}) : null,
    s.todos.length && open.length && !s.approval ? h(Box, {flexDirection: 'column', marginTop: 1}, s.todos.slice(0, 8).map((t, i) => h(Text, {key: i, wrap: 'truncate-end'}, '  ' + todoLine(t)))) : null,
    h(AgentCards, {list: s.agents.filter(x => x.state === 'working' || Date.now() - x.ended < 8000)}),
    s.approval || s.menu ? null : h(Chips, {list: s.attachments}),
    s.approval ? h(Approval, {a: s.approval, ctrl, W}) : s.menu ? h(Menu, {m: s.menu, W}) : h(Prompt, {s, W}),
    s.approval || s.menu ? null : h(Footer, {s, ctrl, W}));
}

function Root({ctrl}) {
  const s = useSyncExternalStore(ctrl.subscribe, ctrl.get);
  const {columns} = useWindowSize(), W = Math.max(40, (columns || 100) - 1);
  useInput((input, key) => ctrl.key(input, key));
  usePaste(text => ctrl.paste(text));
  useEffect(() => { if (s.clearCount) process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); }, [s.clearCount]);
  return h(React.Fragment, null,
    h(Static, {key: s.clearCount, items: s.entries}, e => h(Entry, {key: e.id, e, ctrl, W})),
    h(Live, {s, ctrl, W}));
}

export {Entry, Live};

export function run({agent, museName, version, initial, connect}) {
  let app;
  const ctrl = new Controller({agent, museName, version, onExit: () => {
    app.unmount();
    const id = agent.session.turns && agent.client.status !== 'demo' ? agent.session.id.slice(0, 8) : '';
    if (id) process.stdout.write(c.faint(t('再開するには: muser resume {id}', {id})) + '\n');
    agent.close(); setTimeout(() => process.exit(0), 50);
  }});
  // Start on a clean screen, like Claude Code: the shell prompt and the onboarding output go.
  // The clear goes into Ink's first write, inside its synchronized update (ESC[?2026h … l), so
  // the splash turns into the first frame at once. Written on its own it came ~33 ms (one
  // throttled Ink frame) before that frame: a black flash.
  if (process.stdout.isTTY) {
    const CLEAR = '\x1b[2J\x1b[3J\x1b[H', original = process.stdout.write;
    process.stdout.write = function (chunk, ...rest) {
      process.stdout.write = original;
      const s = String(chunk);
      return original.call(this, s.startsWith('\x1b[?2026h') ? s + CLEAR : CLEAR + s, ...rest);
    };
  }
  app = render(h(Root, {ctrl}), {exitOnCtrlC: false, incrementalRendering: true, maxFps: 30, kittyKeyboard: {mode: process.env.MUSER_KITTY === '1' ? 'auto' : 'disabled'}, patchConsole: true});
  // Drawn before Muse is reached: connect behind the screen; a message sent meanwhile waits for
  // it (runTurn awaits ensureConnected). Then learn Muse's name for next time.
  if (connect) connect().then(name => { if (name && name !== ctrl.museName) { ctrl.museName = name; ctrl.set({}); } }).catch(() => {});
  if (agent.session.turns) ctrl.showResumed(agent.session, {startup: true}); // muser resume / -c
  if (initial) ctrl.submit(initial);
  setTimeout(() => ctrl.refreshPlan(), 1500); // after the first frame: loading the login cookies blocks briefly
  return app;
}
