// Tests read the Japanese UI strings; pin the language so a non-Japanese OS (CI) gives the same.
process.env.MUSER_LANG = 'ja';
// Input history goes to a scratch file: tests that press Enter must never write ~/.muser/history.json
// (one test's prompt landed in the user's real history on 2026-11-01).
import os from 'node:os';
import path from 'node:path';
process.env.MUSER_HISTORY_FILE = path.join(os.tmpdir(), 'muser-test-history-' + process.pid + '.json');
// Same for the per-folder approval mode and "don't ask again" keys (/mode, the approval box).
process.env.MUSER_PERMISSIONS_FILE = path.join(os.tmpdir(), 'muser-test-permissions-' + process.pid + '.json');
// And muser's data folder (sessions.json, transcripts, crash reports, window registry): a test that
// ran a real turn wrote its session into the user's sessions.json.
import fs from 'node:fs';
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-test-data-'));
// And the home folder: ~/.muser/AGENTS.md (the user's instructions for every project) and
// ~/.muser/config.json of the real user were read into tests.
process.env.USERPROFILE = process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-test-home-'));
