// Shows the raw bytes each key press delivers, to debug input from virtual keyboards
// (SteamVR, on-screen keyboard, IME). Run: node scripts/keyprobe.js [--kitty]   ctrl+c to quit.
const kitty = process.argv.includes('--kitty');
process.stdin.setRawMode(true); process.stdin.resume();
if (kitty) process.stdout.write('\x1b[>1u');
console.log('キーを押してください（ctrl+c で終了）' + (kitty ? '  [kitty keyboard ON]' : ''));
process.stdin.on('data', d => {
  if (d.length === 1 && d[0] === 3) { if (kitty) process.stdout.write('\x1b[<u'); process.exit(0); }
  const s = d.toString('utf8');
  console.log('bytes: ' + [...d].map(b => b.toString(16).padStart(2, '0')).join(' ') + '   text: ' + JSON.stringify(s));
});
