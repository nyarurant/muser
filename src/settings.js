'use strict';

const fs = require('node:fs');
const config = require('./config');

// Wave 15: the ceilings startup applies (resolveAgentLimits in src/agent.js:
// MAX_CONCURRENT_AGENTS / MAX_PER_TURN_AGENTS). applyAgentLimits used to take
// any non-negative integer, so /settings could set concurrent=1000 live —
// past the startup ceiling of 64 — and the saved value then silently fell
// back to 64 on the next start. The same clamp now applies here, so a limit
// means the same thing however it was set. 0 still means no limit.
const AGENT_LIMIT_CAPS = {concurrent: 64, perTurn: 1000};
function validateAgentLimits(limits) {
  for (const key of ['concurrent', 'perTurn']) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 0)
      throw new Error('Agent limits must be non-negative safe integers (0 = unlimited).');
  }
  return {concurrent: Math.min(limits.concurrent, AGENT_LIMIT_CAPS.concurrent), perTurn: Math.min(limits.perTurn, AGENT_LIMIT_CAPS.perTurn)};
}

// Persist first: a failed save must not silently apply a session-only change.
// Running workers are left alone; spawn() consults these limits for the next launch.
function applyAgentLimits(agent, limits, {save = false} = {}) {
  const next = validateAgentLimits(limits);
  if (save) config.update(cfg => { cfg.maxAgents = next.concurrent; cfg.maxAgentsTotal = next.perTurn; });
  agent.agentLimits = next;
  return next;
}

// On/off settings kept in ~/.muser/config.json: the key there, the value without one, and the
// environment variable that wins over the file (as it did before these could be saved).
const SWITCHES = {
  focus: {def: true},
  // The work log (src/worklog.js): every conversation's turns, tool calls,
  // edits and replies, kept locally. Default on (design §1).
  worklog: {def: true},
  // A finished !command's output goes to Muse at once, which then answers (as Claude Code does).
  bangAutoSend: {def: true},
  // A finished background shell starts a turn on its own, so the work resumes by itself.
  bgAutoResume: {def: true},
  bell: {def: true, env: 'MUSER_NO_BELL', envValue: false},
  updateCheck: {def: true, env: 'MUSER_NO_UPDATE_CHECK', envValue: false, env2: 'MUSER_UPDATE_CHECK', env2Value: true},
  motion: {def: true, env: 'MUSER_REDUCED_MOTION', envValue: false},
  codeWrap: {def: false, env: 'MUSER_CODE_WRAP', envValue: true},
  // The footer's status lane, element by element. The window slot is internal bookkeeping
  // (which node id this window holds), so it starts off; /status and doctor still name it.
  footerDevice: {def: true},
  footerSlot: {def: false},
  footerName: {def: true},
  footerUsage: {def: true},
  footerCwd: {def: true},
  footerSession: {def: false},
  footerVersion: {def: false},
  footerClock: {def: false},
  // Read once at startup (the colours and the keyboard protocol are fixed when the screen starts).
  color: {def: true, env: 'NO_COLOR', envValue: false, any: true, restart: true},
  kitty: {def: false, env: 'MUSER_KITTY', envValue: true, restart: true},
  // The fullscreen screen (src/ui/fs/): muser draws the whole terminal, with its own scrolling.
  // On by default since 2026-11-06 (the user's choice); MUSER_CLASSIC=1 starts the classic screen.
  fullscreen: {def: true, env: 'MUSER_CLASSIC', envValue: false, restart: true},
  // Code memory (muser lore): /lore and /why read it and turns sync it from the work log.
  lore: {def: true},
};
// Numbers: default, allowed range, the environment variable that wins over the file.
const NUMBERS = {
  maxToolCallsPerTurn: {def: 250, min: 1, max: 100000, env: 'MUSER_MAX_TOOL_CALLS_PER_TURN'},
  dailyTurnLimit: {def: 0, min: 0, max: 100000, env: 'MUSER_DAILY_TURN_LIMIT'}, // 0 = no warning
  focusRounds: {def: 3, min: 1, max: 10},
  // Work log retention in days (design §1/§12: 30 days, and 500 MB total —
  // the byte cap is fixed in src/worklog.js).
  worklogDays: {def: 30, min: 1, max: 3650},
  focusMinutes: {def: 15, min: 1, max: 240},
  // Open muser windows (node slots) per account, and the Muser Server's open conversations:
  // one cap for both, so a conversation always has a node slot of its own to register.
  // 64 is the hard cap against a runaway; the pool itself is dynamic (slots are registered
  // while open and unpaired on close), so the cap is a ceiling, not a fixed set of windows.
  maxNodeSlots: {def: 16, min: 1, max: 64},
  // Overnight work (src/overnight/): one night's caps. 0 = no cap of that kind.
  overnightTokenCap: {def: 0, min: 0, max: 100000000},
  overnightMaxTasks: {def: 0, min: 0, max: 1000},
};
// Kept in a cache: the screen asks for motion / codeWrap on every frame. The cache is keyed
// on config.json's stamp (mtime + size), so a change saved by ANOTHER window is picked up on
// the next read instead of only at restart (audit #223: reloadSwitches() had no production
// caller, so other windows' changes never landed and /settings disagreed with the fresh
// file reads elsewhere, e.g. update.enabled()). A stat per read is cheap; the file is only
// re-parsed when its stamp actually changed.
let cache = null, cacheStamp;
// c27 #8: the stamp used to be mtimeMs + size only, so a same-size rewrite
// landing in the same millisecond (or a timestamp-preserving restore) was
// read as "unchanged" and the running window kept the old settings until
// some other change happened to alter the size or mtime. The stamp now
// also carries the inode and nanosecond mtime/ctime (bigint stat): an
// in-place rewrite moves ctimeNs, a rename-restore changes the inode, and
// neither depends on the wall clock's millisecond landing.
function configStamp() { try { const s = fs.statSync(config.file(), {bigint: true}); return s.ino + ':' + s.size + ':' + s.mtimeNs + ':' + s.ctimeNs; } catch { return null; } }
function savedSwitches() {
  const stamp = configStamp();
  if (!cache || stamp !== cacheStamp) {
    cacheStamp = stamp;
    const cfg = config.read();
    // Wave 14: the saved value is read as the value it names, not only as its exact
    // JSON type — a switch saved as "off" / "yes" / 0 / 1 and a number saved as a
    // string ("100") mean those values (config.normalizeConfig already rescues the
    // known keys; this keeps the reading right for any value that reaches here).
    // Anything no spelling covers falls back to the default — never to the opposite.
    const bool = (v, d) => { if (typeof v === 'boolean') return v; if (v === 0) return false; if (v === 1) return true; if (typeof v === 'string') { const low = v.trim().toLowerCase(); if (['true', '1', 'yes', 'on'].includes(low)) return true; if (['false', '0', 'no', 'off'].includes(low)) return false; } return d.def; };
    const num = (v, d) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return Number.isSafeInteger(n) && n >= d.min && n <= d.max ? n : d.def; };
    cache = {
      ...Object.fromEntries(Object.entries(SWITCHES).map(([k, d]) => [k, bool(cfg[k], d)])),
      ...Object.fromEntries(Object.entries(NUMBERS).map(([k, d]) => [k, num(cfg[k], d)])),
      defaultMode: require('./policy').MODES.includes(cfg.defaultMode) ? cfg.defaultMode : 'default',
      quotaFallback: QUOTA_FALLBACKS.includes(cfg.quotaFallback) ? cfg.quotaFallback : 'auto',
      focusLogLevel: FOCUS_LOG_LEVELS.includes(cfg.focusLogLevel) ? cfg.focusLogLevel : 'normal',
      expectMode: EXPECT_MODES.includes(cfg.expectMode) ? cfg.expectMode : 'record',
      overnightApproval: OVERNIGHT_APPROVALS.includes(cfg.overnightApproval) ? cfg.overnightApproval : 'edit-auto',
    };
  }
  return cache;
}
// The environment variable that decides this setting right now, if any. NO_COLOR counts when
// present at all, even set empty, as no-color.org says. The others use the one set of boolean
// spellings for every settings surface (wave 14, config.envBool): a value that parses as a
// boolean decides the setting either way (wave 17) — 1/true/yes/on give the variable's own
// value (envValue / env2Value), 0/false/no/off give its opposite, so an env var can turn a
// switch the file turned on back off — and any other spelling is not a boolean, so the
// override stays off instead of silently meaning "1 only". A switch can carry a second
// variable with the opposite pull (env2: MUSER_UPDATE_CHECK forces the update check on, as
// update.enabled() has always done); the first variable that parses wins.
// A number's env value counts only as a plain decimal (wave 17): the bare Number() it used
// to go through reads a whitespace-only value as 0 — silently clamping to the minimum — and
// a hex string like 0x10 as 16. Anything else (blank after trimming included) is not an
// override at all, and the saved value decides.
function envNumber(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function envOverride(name) {
  const d = SWITCHES[name] || NUMBERS[name];
  if (!d?.env && !d?.env2) return null;
  const v = process.env[d.env];
  if (NUMBERS[name]) return envNumber(v) !== null ? d.env : null;
  if (d.any) return v !== undefined ? d.env : null;
  if (d.env && config.envBool(v) !== null) return d.env;
  if (d.env2 && config.envBool(process.env[d.env2]) !== null) return d.env2;
  return null;
}
function switchValue(name) { const o = envOverride(name), d = SWITCHES[name]; if (!o) return savedSwitches()[name]; const base = o === d.env2 ? d.env2Value : d.envValue; return !d.any && config.envBool(process.env[o]) === false ? !base : base; }
// What config.json holds, whatever an environment variable says now: /settings flips THIS. It
// flipped the value in effect, so under MUSER_NO_BELL=1 every press saved "on" and the saved
// value could never be turned off again.
function savedValue(name) { return savedSwitches()[name]; }
// c27 #7: after a save, the setters used to assign their value straight
// into the cache (`savedSwitches()[name] = ...`). If another window's save
// landed between this window's config.update and that assignment,
// savedSwitches() re-read the file (stamp updated to the OTHER window's
// value) and the assignment then overwrote just this key with the STALE
// value — with the stamp now matching the file, no re-read ever repaired
// it, and this window kept returning a value no file holds. After a save
// the cache is therefore invalidated, never assigned: the next read
// re-parses the file as it actually stands. A session-only change
// (save:false) has no file write to race with and still assigns.
function setSwitch(name, on, {save = true} = {}) {
  if (!SWITCHES[name]) throw new Error('Unknown setting ' + name);
  if (save) { config.update(cfg => { cfg[name] = !!on; }); reloadSwitches(); }
  else savedSwitches()[name] = !!on;
}
function reloadSwitches() { cache = null; cacheStamp = undefined; }
// The env value is clamped to the same range setNumber and the saved-value read enforce:
// it used to be floored and raised to the minimum but never lowered to the maximum, so a
// mistyped MUSER_MAX_TOOL_CALLS_PER_TURN (an extra zero) silently lifted the cap past it.
function numberValue(name) { const o = envOverride(name); return o ? Math.min(NUMBERS[name].max, Math.max(NUMBERS[name].min, Math.floor(envNumber(process.env[o])))) : savedSwitches()[name]; }
function setNumber(name, n, {save = true} = {}) {
  const d = NUMBERS[name];
  if (!d) throw new Error('Unknown setting ' + name);
  if (!Number.isSafeInteger(n) || n < d.min || n > d.max) throw new Error(name + ' must be an integer from ' + d.min + ' to ' + d.max + '.');
  if (save) { config.update(cfg => { cfg[name] = n; }); reloadSwitches(); } // c27 #7: invalidate, do not assign (see setSwitch)
  else savedSwitches()[name] = n;
}
// What the weekly-limit question (src/ui/controller.mjs askQuotaChoice) does when nobody
// answers it: auto = go on if extra usage was bought, else hand over; extra = always go on;
// handover = always hand over (when another account can take it); ask = wait for an answer.
const QUOTA_FALLBACKS = ['auto', 'extra', 'handover', 'ask'];
// Read from the file each time (the question comes rarely): the cached value missed a change
// made in another window's /settings until this one restarted.
function quotaFallback() {
  try { const v = config.read().quotaFallback; if (QUOTA_FALLBACKS.includes(v)) return v; } catch {} // c27 #7: no cache assignment here either — a fresher write could land between the read and the assign
  return savedSwitches().quotaFallback;
}
function setQuotaFallback(v, {save = true} = {}) {
  if (!QUOTA_FALLBACKS.includes(v)) throw new Error('Unknown quota fallback ' + v);
  if (save) { config.update(cfg => { cfg.quotaFallback = v; }); reloadSwitches(); } // c27 #7
  else savedSwitches().quotaFallback = v;
}
// The Focus decision log's verbosity (weakness 9, 2026-11-06): off = nothing
// recorded, normal = decisions and reasons only (default), verbose = tool
// params and the head of results too. Read through the stamp-cached
// savedSwitches, like defaultMode, so a change in another window lands.
const FOCUS_LOG_LEVELS = ['off', 'normal', 'verbose'];
function focusLogLevel() { return savedSwitches().focusLogLevel; }
function setFocusLogLevel(v, {save = true} = {}) {
  if (!FOCUS_LOG_LEVELS.includes(v)) throw new Error('Unknown focus log level ' + v);
  if (save) { config.update(cfg => { cfg.focusLogLevel = v; }); reloadSwitches(); } // c27 #7
  else savedSwitches().focusLogLevel = v;
}
// 想定外ストップ (src/expect.js): record = 記録だけ (the default the user
// chose 2026-11-07 over design §4's on/off), stop = 記録して次の書き込みを
// 1 回止める, off = expect を受け取っても何もしない. Read through the
// stamp-cached savedSwitches, like focusLogLevel, so a change made in
// another window's /settings lands without a restart.
const EXPECT_MODES = ['record', 'stop', 'off'];
function expectMode() { return savedSwitches().expectMode; }
function setExpectMode(v, {save = true} = {}) {
  if (!EXPECT_MODES.includes(v)) throw new Error('Unknown expect mode ' + v);
  if (save) { config.update(cfg => { cfg.expectMode = v; }); reloadSwitches(); } // c27 #7
  else savedSwitches().expectMode = v;
}
// Overnight work's approval default (design §8/§12, the design's own proposal
// adopted): edit-auto = edits run on their own, a command that needs
// confirmation defers its task to the morning; confirm-all = anything needing
// approval defers; bypass = everything runs (the user opted in explicitly).
const OVERNIGHT_APPROVALS = ['edit-auto', 'confirm-all', 'bypass'];
function overnightApproval() { return savedSwitches().overnightApproval; }
function setOvernightApproval(v, {save = true} = {}) {
  if (!OVERNIGHT_APPROVALS.includes(v)) throw new Error('Unknown overnight approval ' + v);
  if (save) { config.update(cfg => { cfg.overnightApproval = v; }); reloadSwitches(); }
  else savedSwitches().overnightApproval = v;
}
// The approval mode for a folder that has none remembered yet.
function defaultMode() { return savedSwitches().defaultMode; }
function setDefaultMode(mode, {save = true} = {}) {
  if (!require('./policy').MODES.includes(mode)) throw new Error('Unknown mode ' + mode);
  if (save) { config.update(cfg => { cfg.defaultMode = mode; }); reloadSwitches(); } // c27 #7
  else savedSwitches().defaultMode = mode;
}

module.exports = {validateAgentLimits, applyAgentLimits, SWITCHES, NUMBERS, switchValue, savedValue, setSwitch, envOverride, reloadSwitches, numberValue, setNumber, defaultMode, setDefaultMode, QUOTA_FALLBACKS, quotaFallback, setQuotaFallback, FOCUS_LOG_LEVELS, focusLogLevel, setFocusLogLevel, OVERNIGHT_APPROVALS, overnightApproval, setOvernightApproval};
module.exports.envBool = config.envBool;
module.exports.EXPECT_MODES = EXPECT_MODES;
module.exports.expectMode = expectMode;
module.exports.setExpectMode = setExpectMode;
