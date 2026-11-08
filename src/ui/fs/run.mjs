// The fullscreen entry: the shared session setup (src/ui/boot.mjs) with the
// screen drawn by src/ui/fs/ itself. Nothing here loads React or Ink —
// entries and the live area come from the draw registry (src/ui/fs/draw/),
// and a part with nothing to draw draws nothing (no React fallback).
import {createRequire} from 'node:module';
import {bootSession} from '../boot.mjs';
import {runFullscreen} from './app.mjs';
import {drawEntry, drawLive} from './draw/index.mjs';
import {hex} from './draw/primitives.mjs';
const require = createRequire(import.meta.url);
const {t} = require('../../i18n.js');
const {switchValue} = require('../../settings.js');

const DIM = '#5f5f69';

export function run({agent, museName, version, initial, connect, onReload, remoteCtrl}) {
  let app;
  const session = bootSession({agent, museName, version, initial, connect, onReload, remoteCtrl,
    hooks: {unmount: () => { try { app?.unmount(); } catch {} }}});
  const ctrl = session.ctrl;
  const ctx = W => ({ctrl, W, cols: W + 1, rows: process.stdout.rows || 30, now: Date.now(), codeWrap: switchValue('codeWrap')});
  app = runFullscreen({ctrl, dim: hex(DIM),
    renderEntry: (e, W) => drawEntry(e, ctx(W)) ?? [],
    renderLive: (s, W) => drawLive(s, ctx(W)) ?? {lines: [], caret: null},
    labels: {unseen: t('↓ 新しい出力 {n} 件 · PgDn / Ctrl+End で最下部'), scrolled: t('↑ 前の表示 · PgDn / Ctrl+End で最下部'),
      copied: t('コピーしました（{n} 文字）'), copyFailed: t('コピーできませんでした')}});
  session.start();
  return app;
}
