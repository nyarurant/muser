// Phase 2 merge follow-up: t7 #19 — handoff cuts must not split surrogate pairs.
const test = require('node:test');
const assert = require('node:assert/strict');
const {buildHandoff} = require('../src/handoff.js');

const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('fix2 handoff t7 #19: per-turn clip does not split a surrogate pair', () => {
  const text = 'a'.repeat(299) + '\u{1F600}' + 'b'.repeat(50);
  const out = buildHandoff({fromLabel: 'A', toLabel: 'B', cwd: 'C:/x', turns: [{user: text}]});
  assert.ok(!LONE_HIGH.test(out), 'no lone high surrogate');
  assert.ok(!LONE_LOW.test(out), 'no lone low surrogate');
});

test('fix2 handoff t7 #19: one-line fields and the total cap are surrogate-safe too', () => {
  const goal = 'g'.repeat(199) + '\u{1F600}' + 'h'.repeat(50);
  const out = buildHandoff({fromLabel: 'A', toLabel: 'B', cwd: 'C:/x', focus: {goal, criteria: [{text: goal, status: 'pending'}]}, turns: []});
  assert.ok(!LONE_HIGH.test(out), 'no lone high surrogate');
  assert.ok(!LONE_LOW.test(out), 'no lone low surrogate');
});
