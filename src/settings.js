'use strict';

const fs = require('node:fs');
const config = require('./config');

function validateAgentLimits(limits) {
  for (const key of ['concurrent', 'perTurn']) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 0)
      throw new Error('Agent limits must be non-negative safe integers (0 = unlimited).');
  }
  return {concurrent: limits.concurrent, perTurn: limits.perTurn};
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
  // A finished !command's output goes to Muse at once, which then answers (as Claude Code does).
  bangAutoSend: {def: true},
  // A finished background shell starts a turn on its own, so the work resumes by itself.
  bgAutoResume: {def: true},
  bell: {def: true, env: 'MUSER_NO_BELL', envValue: false},
  updateCheck: {def: true, env: 'MUSER_NO_UPDATE_CHECK', envValue: false},
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
};
// Numbers: default, allowed range, the environment variable that wins over the file.
const NUMBERS = {
  maxToolCallsPerTurn: {def: 250, min: 1, max: 100000, env: 'MUSER_MAX_TOOL_CALLS_PER_TURN'},
  dailyTurnLimit: {def: 0, min: 0, max: 100000, env: 'MUSER_DAILY_TURN_LIMIT'}, // 0 = no warning
  focusRounds: {def: 3, min: 1, max: 10},
  focusMinutes: {def: 15, min: 1, max: 240},
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
    const cfg = config.read(), num = (v, d) => Number.isSafeInteger(v) && v >= d.min && v <= d.max ? v : d.def;
    cache = {
      ...Object.fromEntries(Object.entries(SWITCHES).map(([k, d]) => [k, typeof cfg[k] === 'boolean' ? cfg[k] : d.def])),
      ...Object.fromEntries(Object.entries(NUMBERS).map(([k, d]) => [k, num(cfg[k], d)])),
      defaultMode: require('./policy').MODES.includes(cfg.defaultMode) ? cfg.defaultMode : 'default',
      quotaFallback: QUOTA_FALLBACKS.includes(cfg.quotaFallback) ? cfg.quotaFallback : 'auto',
    };
  }
  return cache;
}
// The environment variable that decides this setting right now, if any (NO_COLOR counts when
// present at all, even set empty, as no-color.org says; the others when set to 1).
function envOverride(name) {
  const d = SWITCHES[name] || NUMBERS[name];
  if (!d?.env) return null;
  const v = process.env[d.env];
  if (NUMBERS[name]) return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? d.env : null;
  return (d.any ? v !== undefined : v === '1') ? d.env : null;
}
function switchValue(name) { return envOverride(name) ? SWITCHES[name].envValue : savedSwitches()[name]; }
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
function numberValue(name) { const o = envOverride(name); return o ? Math.min(NUMBERS[name].max, Math.max(NUMBERS[name].min, Math.floor(Number(process.env[o])))) : savedSwitches()[name]; }
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
// The approval mode for a folder that has none remembered yet.
function defaultMode() { return savedSwitches().defaultMode; }
function setDefaultMode(mode, {save = true} = {}) {
  if (!require('./policy').MODES.includes(mode)) throw new Error('Unknown mode ' + mode);
  if (save) { config.update(cfg => { cfg.defaultMode = mode; }); reloadSwitches(); } // c27 #7
  else savedSwitches().defaultMode = mode;
}

module.exports = {validateAgentLimits, applyAgentLimits, SWITCHES, NUMBERS, switchValue, savedValue, setSwitch, envOverride, reloadSwitches, numberValue, setNumber, defaultMode, setDefaultMode, QUOTA_FALLBACKS, quotaFallback, setQuotaFallback};
