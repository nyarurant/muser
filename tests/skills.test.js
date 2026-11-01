'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A scratch home and project, so the user's real skills and config are never read or written.
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-skills-'));
  const home = path.join(root, 'home'), proj = path.join(root, 'proj');
  fs.mkdirSync(home); fs.mkdirSync(proj);
  const saved = {USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME};
  process.env.USERPROFILE = home; process.env.HOME = home;
  t.after(() => { Object.assign(process.env, saved); fs.rmSync(root, {recursive: true, force: true}); });
  const put = (dir, name, md, extra = {}) => {
    const d = path.join(dir, name); fs.mkdirSync(d, {recursive: true});
    fs.writeFileSync(path.join(d, 'SKILL.md'), md);
    for (const [f, c] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(d, f)), {recursive: true}); fs.writeFileSync(path.join(d, f), c); }
  };
  return {home, proj, put};
}

test('frontmatter as skills write it: plain, quoted, folded and literal blocks', () => {
  const {frontmatter} = require('../src/skills');
  const fm = frontmatter('---\nname: a\ndescription: >-\n  first line\n  second line\nother: "quoted: yes"\nlit: |\n  x\n  y\n---\nBody here\n');
  assert.equal(fm.meta.name, 'a');
  assert.equal(fm.meta.description, 'first line second line');
  assert.equal(fm.meta.other, 'quoted: yes');
  assert.equal(fm.meta.lit, 'x\ny');
  assert.equal(fm.body, 'Body here\n');
  assert.deepEqual(frontmatter('no frontmatter').meta, {});
});

test('skills come from muser, the project, Claude Code and Codex folders; the project wins a name clash', t => {
  const {home, proj, put} = sandbox(t);
  const skills = require('../src/skills');
  put(path.join(home, '.claude', 'skills'), 'release', '---\nname: release\ndescription: from claude\n---\n');
  put(path.join(home, '.codex', 'skills'), 'design', '---\nname: design\ndescription: from codex\n---\n');
  put(path.join(proj, '.muser', 'skills'), 'release', '---\nname: release\ndescription: from the project\n---\n');
  fs.mkdirSync(path.join(home, '.codex', 'skills', 'not-a-skill'), {recursive: true});
  const all = skills.load(proj);
  assert.deepEqual(all.map(s => [s.name, s.source, s.description]).sort(), [['design', 'codex', 'from codex'], ['release', 'project', 'from the project']]);
});

test('turning a skill or a whole source off takes it out of the preamble and of skill.read', t => {
  const {home, proj, put} = sandbox(t);
  const skills = require('../src/skills');
  put(path.join(home, '.claude', 'skills'), 'one', '---\nname: one\ndescription: first\n---\n');
  put(path.join(home, '.codex', 'skills'), 'two', '---\nname: two\ndescription: second\n---\n');
  assert.match(skills.preambleLines(proj).join('\n'), /- one: first[\s\S]*- two: second/);
  skills.setEnabled('one', false);
  assert.ok(!/- one:/.test(skills.preambleLines(proj).join('\n')));
  assert.throws(() => skills.read(proj, {name: 'one'}), /turned off/);
  skills.setSourceEnabled('codex', false);
  assert.deepEqual(skills.preambleLines(proj), [], 'nothing on, nothing listed');
  skills.setEnabled('one', true); skills.setSourceEnabled('codex', true);
  assert.equal(skills.load(proj).filter(s => s.enabled).length, 2);
});

test('skill.read gives SKILL.md with its files, or one file inside; never outside the folder', t => {
  const {home, proj, put} = sandbox(t);
  const skills = require('../src/skills');
  put(path.join(home, '.muser', 'skills'), 'guide', '---\nname: guide\ndescription: d\n---\nDo X.\n', {'references/more.md': 'More.', 'scripts/run.ps1': 'echo'});
  fs.writeFileSync(path.join(home, 'secret.txt'), 'nope');
  const r = skills.read(proj, {name: 'guide'});
  assert.match(r.content, /Do X\./);
  assert.deepEqual(r.files.sort(), ['SKILL.md', 'references/more.md', 'scripts/run.ps1']);
  assert.equal(skills.read(proj, {name: 'guide', path: 'references/more.md'}).content, 'More.');
  assert.throws(() => skills.read(proj, {name: 'guide', path: '../../secret.txt'}), /inside the skill folder/);
  assert.throws(() => skills.read(proj, {name: 'missing'}), /No skill named/);
});

test('skill.read is a read tool that read-only agent types may use', () => {
  const {TOOLS} = require('../src/tools');
  const agentTypes = require('../src/agent-types');
  assert.equal(TOOLS['skill.read'].kind, 'read');
  assert.ok(agentTypes.allows(agentTypes.load(process.cwd()).explore, 'skill.read'));
});

test('a SKILL.md saved with a BOM keeps its description', t => {
  const {proj, put} = sandbox(t);
  put(path.join(proj, '.muser', 'skills'), 'bom', String.fromCharCode(0xfeff) + '---\nname: bom\ndescription: Saved by Notepad\n---\nbody');
  const s = require('../src/skills').load(proj).find(x => x.name === 'bom');
  assert.equal(s.description, 'Saved by Notepad');
});

test('skill.read does not follow a link out of the skill or read a secret', t => {
  const {home, proj, put} = sandbox(t);
  const ssh = path.join(home, '.ssh'); fs.mkdirSync(ssh); fs.writeFileSync(path.join(ssh, 'mykey'), 'PRIVATE');
  put(path.join(proj, '.claude', 'skills'), 'evil', '---\nname: evil\ndescription: x\n---\n', {'notes.md': 'fine', '.env': 'SECRET=1'});
  fs.symlinkSync(ssh, path.join(proj, '.claude', 'skills', 'evil', 'keys'), 'junction');
  const skills = require('../src/skills');
  assert.equal(skills.read(proj, {name: 'evil', path: 'notes.md'}).content, 'fine');
  assert.throws(() => skills.read(proj, {name: 'evil', path: 'keys/mykey'}), /inside the skill folder|sensitive/);
  assert.throws(() => skills.read(proj, {name: 'evil', path: '.env'}), /sensitive/);
});

test('a config.json that does not parse is kept aside, not wiped, when a setting is saved', t => {
  const {home} = sandbox(t);
  const dir = path.join(home, '.muser'); fs.mkdirSync(dir, {recursive: true});
  const f = path.join(dir, 'config.json'), broken = '{"lang": "ja", "maxAgents": 0,}';
  fs.writeFileSync(f, broken);
  require('../src/skills').setEnabled('x', false);
  const aside = fs.readdirSync(dir).find(n => n.startsWith('config.json.corrupt-'));
  assert.ok(aside, 'the unreadable file was moved aside');
  assert.equal(fs.readFileSync(path.join(dir, aside), 'utf8'), broken);
  fs.writeFileSync(f, JSON.stringify({lang: 'ja', maxAgents: 0, skills: {disabled: ['x']}}));
  require('../src/skills').setEnabled('y', false);
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(cfg.maxAgents, 0, 'other settings survive a save');
  assert.deepEqual(cfg.skills.disabled, ['x', 'y']);
});
