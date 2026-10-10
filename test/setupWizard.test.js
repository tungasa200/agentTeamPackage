// 설치 마법사(D-171): setup.cmd → scripts/setup-wizard.ps1. 창은 띄우지 않고 파일 형식·구문만 본다
//   node test/setupWizard.test.js
//   화면 확인은 손으로: powershell -STA -File scripts\setup-wizard.ps1 -Shots <폴더> [-Scale 1.5] (가짜 출력으로 화면 상태를 PNG로 저장)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG = path.resolve(__dirname, '..');
const WIZ = path.join(PKG, 'scripts', 'setup-wizard.ps1');
const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// 1. setup.cmd: 마법사를 콘솔 없이 띄운다. cmd는 코드 페이지로 읽으므로 ASCII만
const cmd = fs.readFileSync(path.join(PKG, 'setup.cmd'), 'utf8');
assert.ok(/^[\x00-\x7f]*$/.test(cmd), 'setup.cmd는 ASCII만');
assert.ok(cmd.includes('-WindowStyle Hidden') && cmd.includes('-STA') && cmd.includes('%~dp0scripts\\setup-wizard.ps1'), cmd);

// 2. .ps1: BOM(PowerShell 5.1이 한글을 깨뜨리지 않게), 변수 바로 뒤 한글 금지('$n개'는 변수 n개로 읽혀 빈 값)
const ps1 = [path.join(PKG, 'install.ps1'), ...fs.readdirSync(path.join(PKG, 'scripts')).filter((f) => f.endsWith('.ps1')).map((f) => path.join(PKG, 'scripts', f))];
for (const f of ps1) {
  const buf = fs.readFileSync(f);
  const rel = path.relative(PKG, f);
  if (/[^\x00-\x7f]/.test(buf.toString('utf8'))) assert.ok(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, `${rel}: UTF-8 BOM 필요`);
  buf.toString('utf8').split(/\r?\n/).forEach((l, i) => {
    const m = l.match(/\$(?:script:)?[A-Za-z_][A-Za-z0-9_]*[\uac00-\ud7a3]/);
    assert.ok(!m, `${rel}:${i + 1}: 변수 뒤에 한글이 붙음 '${m && m[0]}' → $(변수) 로 감싸기`);
  });
}

// 2b. 마법사: 글꼴 $F·색 $C와 대소문자만 다른 변수($f·$c) 금지. PowerShell 변수는 대소문자를 안 가리고 동적 범위라
//     함수 안의 $f가 그 함수에서 부르는 화면 함수의 $F.Title까지 덮는다(0.9.0 캡처에서 제목 글꼴이 작아짐)
fs.readFileSync(WIZ, 'utf8').split(/\r?\n/).forEach((l, i) => {
  if (/^\$(F|C) = /.test(l)) return;
  const m = l.match(/\$(f|c|F|C)\b(?![.\w])/);
  assert.ok(!m, `setup-wizard.ps1:${i + 1}: '${m && m[0]}'는 $F(글꼴)·$C(색)를 덮음 → 다른 이름`);
});

// 3. 구문: PowerShell 파서 오류 없음
const parse = `$e = $null; [void][Management.Automation.Language.Parser]::ParseFile('${WIZ}', [ref]$null, [ref]$e); $e | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message }`;
const r = spawnSync(POWERSHELL, ['-NoProfile', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${parse}`], { encoding: 'utf8' });
assert.strictEqual(r.status, 0, r.stderr);
assert.strictEqual(r.stdout.trim(), '', `setup-wizard.ps1 구문 오류:\n${r.stdout}`);

// 4. 마법사가 부르는 install.js 명령·플래그가 실제로 있다
const wiz = fs.readFileSync(WIZ, 'utf8');
const js = fs.readFileSync(path.join(PKG, 'lib', 'install.js'), 'utf8');
for (const f of ['--progress', '--no-finish', '--todos']) {
  assert.ok(wiz.includes(f), `마법사: ${f}`);
  assert.ok(js.includes(`'${f}'`), `install.js: ${f}`);
}
assert.ok(/ trust --project /.test(wiz) && /cmd === 'trust'/.test(js), 'trust 명령');
console.log('설치 마법사 검사 통과');
