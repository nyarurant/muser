'use strict';
// $name skill calls (Codex style): $ completion in the composer and the
// expansion Controller.submit applies before a message goes to Muse.
const test = require('node:test');
const {after} = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Self-isolation (the controller.test.js pattern): skills.load reads the home
// folder's skill sources and setEnabled writes ~/.muser/config.json, so both
// must point at throwaway dirs before any src module loads.
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-dollar-data-'));
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-dollar-home-'));
const created = [process.env.LOCALAPPDATA, process.env.HOME];
after(() => { for (const d of created) { try { fs.rmSync(d, {recursive: true, force: true}); } catch {} } });

class FakeAgent extends EventEmitter {
  constructor(cwd) {
    super();
    this.mode = 'default'; this.cwd = cwd; this.session = {id: 'x', turns: 0}; this.ctx = {readFiles: new Set()};
    this.client = {status: 'connected'}; this.allowAlways = new Set(); this.device = {connected: true};
  }
}
FakeAgent.DEVICE = 'test';

function skillCwd(defs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-dollar-cwd-')); created.push(dir);
  for (const [name, description] of defs) {
    const d = path.join(dir, '.muser', 'skills', name);
    fs.mkdirSync(d, {recursive: true});
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + description + '\n---\nDo the thing.\n');
  }
  return dir;
}
const SKILLS = [['review', 'Review the code carefully and list problems'], ['revise', 'Revise the text'], ['cook', 'Cook a meal']];
async function makeCtrl(cwd, sent) {
  const {Controller} = await import('../src/ui/controller.mjs');
  const agent = new FakeAgent(cwd);
  if (sent) agent.send = async (body, opts) => { sent.push({body, opts}); };
  const ctrl = new Controller({agent, museName: 'm', version: 't', onExit() {}});
  ctrl.refreshPlan = () => Promise.resolve(null);
  return ctrl;
}
async function renderLive(ctrl) {
  const React = (await import('react')).default, {renderToString} = await import('ink');
  const {Live} = await import('../src/ui/view.mjs');
  const {strip, width} = require('../src/tui/term.js');
  const out = strip(renderToString(React.createElement(Live, {s: ctrl.get(), ctrl, W: 79}), {columns: 80}));
  return {out, lines: out.split('\n'), width};
}

test('$ fragment: start/after whitespace only, a letter first, a$b and $5 are not fragments', () => {
  const skills = require('../src/skills');
  assert.deepEqual(skills.dollarFragmentAt('$', 1), {start: 1, fragment: ''});
  assert.deepEqual(skills.dollarFragmentAt('do $re', 6), {start: 4, fragment: 're'});
  assert.deepEqual(skills.dollarFragmentAt('$Review', 7), {start: 1, fragment: 'review'});
  assert.equal(skills.dollarFragmentAt('a$b', 3), null, 'a $ inside a word is not a trigger');
  assert.equal(skills.dollarFragmentAt('$5', 2), null, 'a price is not a skill');
  assert.equal(skills.dollarFragmentAt('cost $5', 7), null);
  assert.equal(skills.dollarFragmentAt('plain text', 5), null);
});

test('$ completion opens on $, filters by prefix, ↑↓ moves, enter completes without sending', async () => {
  const sent = [];
  const ctrl = await makeCtrl(skillCwd(SKILLS), sent);
  for (const ch of '$re') ctrl.key(ch, {});
  assert.equal(ctrl.get().text, '$re');
  const ctx = ctrl.dollarContext(ctrl.get().text, ctrl.get().pos);
  assert.deepEqual(ctx.list.map(s => s.name), ['review', 'revise'], 'enabled skills starting with the fragment');
  assert.equal(ctrl.dollarIndex('re', ctx.list.length), 0);
  ctrl.key('', {downArrow: true});
  assert.equal(ctrl.get().text, '$re', 'arrows only move the highlight');
  assert.equal(ctrl.dollarIndex('re', 2), 1);
  ctrl.key('', {upArrow: true});
  assert.equal(ctrl.dollarIndex('re', 2), 0);
  ctrl.key('', {downArrow: true});
  ctrl.key('', {return: true});
  assert.equal(ctrl.get().text, '$revise ', 'enter completes the highlighted candidate to $name + space');
  assert.deepEqual(sent, [], 'enter completed, it did not send');
  // A fragment matching nothing has no list.
  ctrl.setText('$zz', 3);
  assert.deepEqual(ctrl.dollarContext(ctrl.get().text, ctrl.get().pos).list, []);
});

test('$ completion: tab completes the highlighted candidate; after whitespace works too', async () => {
  const ctrl = await makeCtrl(skillCwd(SKILLS), []);
  ctrl.setText('$re', 3);
  ctrl.key('', {tab: true});
  assert.equal(ctrl.get().text, '$review ');
  ctrl.setText('please $co now', 10);
  ctrl.key('', {tab: true});
  assert.equal(ctrl.get().text, 'please $cook  now', 'completion replaces only the fragment, keeping the rest');
});

test('$ completion: esc closes the list and keeps the text', async () => {
  const ctrl = await makeCtrl(skillCwd(SKILLS), []);
  ctrl.setText('$re', 3);
  assert.ok(ctrl.dollarContext(ctrl.get().text, ctrl.get().pos)?.list.length);
  ctrl.key('', {escape: true});
  assert.equal(ctrl.dollarContext(ctrl.get().text, ctrl.get().pos), null, 'the list is closed');
  assert.equal(ctrl.get().text, '$re', 'esc did not clear or arm-clear the input');
  ctrl.key('', {escape: true});
  assert.equal(ctrl.get().text, '$re', 'the next esc is the usual first arm, still no clear');
});

test('$ completion: a $ inside a word opens nothing', async () => {
  const ctrl = await makeCtrl(skillCwd(SKILLS), []);
  ctrl.setText('a$b', 3);
  assert.equal(ctrl.dollarContext(ctrl.get().text, ctrl.get().pos), null);
  ctrl.key('', {tab: true});
  assert.equal(ctrl.get().text, 'a$b', 'tab does not complete it either');
});

test('footer: $ candidates render with ❯, name and description, within 79 columns at 80', async () => {
  const ctrl = await makeCtrl(skillCwd([['review', 'Review the code very carefully indeed and list every single problem you can possibly find in it'], ['revise', 'Revise the text']]), []);
  ctrl.setText('$re', 3);
  const {out, lines, width} = await renderLive(ctrl);
  assert.match(out, /❯ \$review/, 'the selected candidate is marked with ❯');
  assert.match(out, /\$revise/, 'the other candidate is listed');
  assert.match(out, /Review the code/, 'the description is shown');
  for (const l of lines) assert.ok(width(l) <= 79, 'footer line within 79 columns: ' + JSON.stringify(l) + ' = ' + width(l));
});

test('footer: no skills says so once', async () => {
  const ctrl = await makeCtrl(skillCwd([]), []);
  ctrl.setText('$', 1);
  const ctx = ctrl.dollarContext(ctrl.get().text, ctrl.get().pos);
  assert.deepEqual(ctx.list, []);
  assert.equal(ctx.noSkills, true);
  const {out} = await renderLive(ctrl);
  assert.equal(out.split('スキルがありません（/skills）').length - 1, 1, 'the no-skills line appears exactly once');
});

test('submit: $review do X sends the skill sentence + the typed text; the user entry shows the typed text', async () => {
  const sent = [];
  const ctrl = await makeCtrl(skillCwd(SKILLS), sent);
  await ctrl.submit('$review do X');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, 'Use the skill "review" (read it with skill.read first). $review do X');
  assert.equal(sent[0].opts.display, '$review do X', 'the transcript display text is what was typed');
  const user = ctrl.get().entries.find(e => e.type === 'user');
  assert.equal(user.text, '$review do X', 'the screen shows what was typed');
});

test('submit: two skills get one sentence each in order; duplicates only once', async () => {
  const sent = [];
  const ctrl = await makeCtrl(skillCwd(SKILLS), sent);
  await ctrl.submit('$cook then $review and $cook again');
  assert.equal(sent[0].body, 'Use the skill "cook" (read it with skill.read first). Use the skill "review" (read it with skill.read first). $cook then $review and $cook again');
});

test('submit: $HOME, $env:PATH, $5, unknown and misspelled names stay plain text', async () => {
  for (const text of ['$HOME is my home', 'path is $env:PATH ok', 'lunch was $5 today', '$unknown do X', '$revie do X', 'a$b and $$review']) {
    const sent = [];
    const ctrl = await makeCtrl(skillCwd(SKILLS), sent);
    await ctrl.submit(text);
    assert.equal(sent.length, 1, text);
    assert.equal(sent[0].body, text, 'untouched: ' + text);
    assert.ok(!ctrl.get().entries.some(e => e.type === 'note'), 'no note for: ' + text);
  }
});

test('submit: punctuation after $name still counts ($review, / $review。)', async () => {
  const sent = [];
  const ctrl = await makeCtrl(skillCwd(SKILLS), sent);
  await ctrl.submit('$review, please');
  assert.ok(sent[0].body.startsWith('Use the skill "review" (read it with skill.read first). $review, please'));
  const sent2 = [];
  const ctrl2 = await makeCtrl(skillCwd(SKILLS), sent2);
  await ctrl2.submit('$review。お願い');
  assert.ok(sent2[0].body.startsWith('Use the skill "review" (read it with skill.read first). '), sent2[0].body);
});

test('submit: a disabled $name stays plain text and is noted', async () => {
  const skills = require('../src/skills');
  const cwd = skillCwd([...SKILLS, ['offskill', 'A skill that is off']]);
  skills.setEnabled('offskill', false);
  const sent = [];
  const ctrl = await makeCtrl(cwd, sent);
  await ctrl.submit('$offskill do X');
  assert.equal(sent[0].body, '$offskill do X', 'sent as plain text');
  const notes = ctrl.get().entries.filter(e => e.type === 'note').flatMap(e => e.lines);
  assert.ok(notes.some(l => l.includes('offskill はオフです（/skills でオンにできます）')), 'the off note shows: ' + notes.join(' / '));
  // And it is not a completion candidate either.
  assert.deepEqual(skills.dollarComplete('off', cwd), []);
});

test('dollarRefs: enabled / disabled / unknown resolution', () => {
  const skills = require('../src/skills');
  const cwd = skillCwd(SKILLS);
  assert.deepEqual(skills.dollarRefs('$review and $cook', cwd), {names: ['review', 'cook'], disabled: []});
  assert.deepEqual(skills.dollarRefs('nothing here', cwd), {names: [], disabled: []});
});
