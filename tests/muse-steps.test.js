'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {MuseSteps, citations} = require('../src/muse-steps');

// Shapes as the gateway returned them (2026-10-31).
const action = (n, status, title, subtitle, msg = 'MSG1') => ({action_index: n, id: 'ga-root-tool-' + msg + '-call_' + n, kind: 'tool_call', status, title, subtitle, report: '...'});
function feed(actions, agentId = 'AG1') {
  return {days: [{activities: [
    {type: 'goal', details: {activity_thread_agent_id: 'OTHER', goal_actions: [action(1, 'SUCCESS', 'Someone else\'s search', '', 'MSG1')]}},
    {type: 'goal', details: {activity_thread_agent_id: agentId, goal_actions: actions}},
  ]}]};
}

test('Muse steps: only this turn\'s actions, device calls hidden unless failed, running one reported', async () => {
  let data = feed([
    action(1, 'SUCCESS', 'Found 0 memory results for Node.js', '0 results for "Node.js LTS"'),
    action(2, 'SUCCESS', 'Listed paired devices', '3 devices online, including devbox CLI (muser)'),
    action(3, 'RUNNING', 'Running: ⁨Searching the web for "⁨Node.js 26⁩"⁩', '処理中'),
    action(4, 'SUCCESS', 'From an earlier turn', '', 'MSG0'),
  ]);
  const client = {request: async () => data};
  const steps = [], running = [];
  const s = new MuseSteps(client, e => { if (e.step) steps.push(e.step); if (e.running !== undefined) running.push(e.running); });
  const w = {turn: {}};
  s.note(w, {agent_id: 'AG1', message_id: 'MSG1'});
  await s.read();
  assert.deepEqual(steps.map(x => x.title), ['Found 0 memory results for Node.js']);
  assert.equal(steps[0].detail, '0 results for "Node.js LTS"');
  assert.equal(running.at(-1), 'Searching the web for "Node.js 26"');

  data = feed([
    action(1, 'SUCCESS', 'Found 0 memory results for Node.js', ''),
    action(2, 'SUCCESS', 'Listed paired devices', ''),
    action(3, 'SUCCESS', 'Found 16 web results for Node.js 26', '16 results including GitHub releases'),
    action(5, 'FAILED', 'Device command failed: code.read on package.json', 'Device homelink-0a1b2c was offline'),
  ]);
  await s.finish(w.turn, w);
  assert.deepEqual(steps.map(x => x.title), ['Found 0 memory results for Node.js', 'Found 16 web results for Node.js 26', 'Device command failed: code.read on package.json']);
  assert.ok(steps[2].failed);
  assert.equal(s.timer, null, 'stops polling when no turn is followed');
});

test('citations: http(s) sources with their domain', () => {
  const r = citations([
    {kind: 'citation', label: 'リリース', metadata: '{"domain":"nodejs.org"}', uri: 'https://nodejs.org/ja/blog/release'},
    {kind: 'citation', label: 'x', uri: 'javascript:alert(1)'},
    {kind: 'image', uri: 'https://example.com/a.png'},
    {kind: 'citation', label: 'npm', uri: 'https://www.npmjs.com/package/ink'},
  ]);
  assert.deepEqual(r, [
    {uri: 'https://nodejs.org/ja/blog/release', label: 'リリース', domain: 'nodejs.org'},
    {uri: 'https://www.npmjs.com/package/ink', label: 'npm', domain: 'www.npmjs.com'},
  ]);
});
