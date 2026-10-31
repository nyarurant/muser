'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {reviewReadOnly, reviewCommand} = require('../src/core/read-only-commands');

const ok = (c) => assert.equal(reviewCommand(c), null, c);
const bad = (c) => {
  const r = reviewCommand(c);
  assert.ok(r && typeof r.reason === 'string' && r.reason.length > 0, c);
};

test('plain readers still pass', () => {
  for (const c of [
    'dir', 'dir C:\\Users', 'echo hello', 'type file.txt', 'tasklist', 'whoami', 'hostname',
    'Get-ChildItem', 'Get-ChildItem -Path C:\\Users', 'Get-ChildItem -Recurse -Filter *.txt',
    'Get-Process', 'Get-Date', 'Get-Content file.txt', 'Get-Item file.txt', 'Get-Location',
    'Get-ChildItem | Select-Object Name, Length', 'Get-ChildItem | Sort-Object Length',
    'Get-Process | Format-Table Name, Id', 'Select-String -Pattern TODO file.txt',
    'Test-Path C:\\Users', 'Get-ChildItem | Measure-Object', 'gci', 'ls', 'pwd',
    'reg query HKCU\\Software', 'netstat -an', 'ipconfig',
  ]) ok(c);
});

test('set: any assignment is flagged, bare and query forms still read', () => {
  ok('set');
  ok('set PATH');
  ok('set X');
  ok('set P');
  bad('set PATH=C:\\evil');
  bad('set Path=C:\\evil');
  bad('set PATHEXT=.EXE');
  bad('set COMSPEC=C:\\evil.exe');
  bad('set FOO=bar');
  bad('set MY_OWN_VARIABLE=1');
  bad('set JAVA_HOME=C:\\java');
  bad('set _X=anything');
  bad('set /a X=1+2');
  bad('set X=Y & dir');
  bad('dir & set FOO=bar');
});

test('date / time: arguments mutate, bare still reads', () => {
  ok('date');
  ok('time');
  bad('date 2026-10-31');
  bad('date 10/31/2026');
  bad('date /t');
  bad('time 12:00');
  bad('time 12:00:00');
  bad('time /t');
  bad('dir & time 01:00');
});

test('Get-* stays read, but dangerous arguments are flagged', () => {
  ok('Get-ChildItem');
  ok('Get-ChildItem -Force');
  ok('Get-Content notes.txt -TotalCount 5');
  ok('Get-Date -Format yyyy');
  bad('Get-ChildItem -ScriptBlock { Get-Date }');
  bad('Get-Thing -ScriptBlock { dir }');
  bad('Get-Content file.txt -OutFile out.txt');
  bad('Get-Data -OutputFile out.txt');
  bad('Get-Data -o out.txt');
  bad('Get-Data -o=out.txt');
  bad('Get-Foo -Destination out.txt');
  bad('Get-Foo Invoke-Expression $x');
  bad('Get-Job -ScriptBlock { Invoke-Expression $x }');
  // A pipeline into a writer / remover is caught segment by segment.
  bad('Get-ChildItem | Remove-Item');
  bad('Get-Process | Stop-Process');
  bad('Get-Content file.txt | Set-Content out.txt');
  bad('Get-ChildItem | Out-File out.txt');
});

test('instance methods: only the read-only allowlist passes', () => {
  for (const c of [
    '$x.ToString()', '$name.Trim()', '$name.TrimStart()', '$name.ToLower()', '$name.ToUpper()',
    '$s.Contains("x")', '$s.StartsWith("a")', '$s.EndsWith("b")', '$s.Substring(0, 3)',
    '$s.Split(",")', '$s.Replace("a", "b")', '$s.IndexOf("x")', '$s.PadLeft(5)', '$s.PadRight(5)',
    '$x.GetType()', '$x.Equals($y)', '$x.GetHashCode()', '$s.Format($fmt, $x)',
    '[string]::Join(",", $x)', '[Math]::Round(1.5)', '[IO.Path]::GetFileName("C:\\a\\b.txt")',
    '$d.AddDays(1)', '$d.ToShortDateString()',
  ]) ok(c);
  for (const c of [
    '$p.Kill()', '$f.Delete()', '$f.DeleteAsync()', '$x.Start()', '$x.Stop()', '$list.Add($y)',
    '$list.Remove($y)', '$list.Clear()', '$obj.SetValue(1)', '$obj.SetAttribute("a", "b")',
    '$sb.Append("x")', '$sb.AppendLine("x")', '$w.WriteLine("x")', '$w.Write("x")', '$f.OpenWrite()',
    '$obj.Save()', '$obj.Execute()', '$obj.Invoke()', '$obj.Send($x)', '$obj.UploadFile($x)',
    '$obj.DownloadFile($x)', '$obj.MoveTo($x)', '$obj.CopyTo($x)', '$obj.CreateFile($x)',
    '$obj.Rename($x)', '$obj.Close()', '$obj.Encrypt()', '$obj.Frobnicate()', '$obj.Munge(1)',
    '$obj.DoSomething()', '$x.Flush()', '$x.Dispose()',
  ]) bad(c);
});

test('earlier denylist behaviour is preserved', () => {
  bad('Remove-Item file.txt');
  bad('Set-Content out.txt x');
  bad('Stop-Process -Name x');
  bad('Invoke-Expression $x');
  bad('echo hi > out.txt');
  bad('del file.txt');
  bad('powershell -EncodedCommand aGVsbG8gd29ybGQhISE=');
  bad('[IO.File]::Delete("x")');
  bad('[Environment]::SetEnvironmentVariable("A", "B")');
  ok('[Environment]::GetEnvironmentVariable("PATH")');
  ok('[DateTime]::Now');
});

test('reviewReadOnly routes system.run through reviewCommand', () => {
  assert.equal(reviewReadOnly('file.read', {}), null);
  assert.equal(reviewReadOnly('device.health', {}), null);
  assert.ok(reviewReadOnly('file.write', {}));
  assert.ok(reviewReadOnly('nope.unknown', {}));
  assert.equal(reviewReadOnly('system.run', {command: 'Get-ChildItem'}), null);
  assert.equal(reviewReadOnly('system.run', {command: 'set'}), null);
  assert.ok(reviewReadOnly('system.run', {command: 'set FOO=bar'}));
  assert.ok(reviewReadOnly('system.run', {command: 'date 2026-01-01'}));
  assert.ok(reviewReadOnly('system.run', {command: '$p.Kill()'}));
  assert.ok(reviewReadOnly('companion.act', {action: 'say'}));
  assert.equal(reviewReadOnly('companion.act', {action: 'wave'}), null);
});
