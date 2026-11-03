'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const clip = require('../src/clipboard');

function tmpFile(t, name, bytes = Buffer.from([1, 2, 3])) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-clip-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const f = path.join(dir, name);
  fs.writeFileSync(f, bytes);
  return f;
}

test('attachment: a supported image keeps its real type', t => {
  const a = clip.attachment(tmpFile(t, 'shot.PNG')); // extension case does not matter
  assert.equal(a.type, 'image/png');
  assert.equal(a.name, 'shot.PNG');
  assert.equal(clip.attachment(tmpFile(t, 'photo.webp')).type, 'image/webp');
  assert.equal(clip.attachment(tmpFile(t, 'anim.gif')).type, 'image/gif');
});

// Audit #242: an unsupported file used to be sent to the API labelled image/png,
// because attachment() defaulted the type instead of checking the extension.
test('attachment: a non-image file is refused, not relabelled image/png', t => {
  for (const name of ['notes.txt', 'data.json', 'vector.svg', 'noextension']) {
    assert.throws(() => clip.attachment(tmpFile(t, name)), /画像ファイル/, name);
  }
});
