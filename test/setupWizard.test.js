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
for (const f of ['--progress', '--no-finish', '--todos', '--no-worktree']) { // worktree 켬(기본)은 넘기지 않음
  assert.ok(wiz.includes(f), `마법사: ${f}`);
  assert.ok(js.includes(`'${f}'`), `install.js: ${f}`);
}
assert.ok(/ trust --project /.test(wiz) && /cmd === 'trust'/.test(js), 'trust 명령');

// 5. 사용자에게 개발 용어를 보이지 않는다: [자세히]에 점검 원문(title·fix)을 넣지 않고, 이름 없는 스택 도구는 일반 이름
assert.ok(!/\$detail\[\$gname\] \+= \(?"\$\(\$r\.title\)/.test(wiz) && /Get-FriendlyLine \$r /.test(wiz) && /Show-Detail \$x\.Detail/.test(wiz), '[자세히]는 쉬운 말 두 줄 창(W7-d)');
assert.ok(/를 확인하지 못했습니다\.'?"?; Do = 'setup을 다시 실행해 주세요\.'/.test(wiz), '바꿀 말이 없는 항목 문구(목업 W7-d)');
assert.ok(/progress\(`tool stack-\$\{t\.cmd\} installing \$\{t\.label \|\| t\.cmd\}`\)/.test(js), 'install.js 스택 도구 진행 줄 형식(바뀌면 마법사 이름 처리도 확인)');
assert.ok(/"\$base 개발 도구"/.test(wiz) && /Get-StackToolName/.test(wiz) &&/if \(\$state -ne 'failed'\) \{ \$label = "\$code \$label"\.Trim\(\)/.test(wiz), '스택 도구 이름: 여러 낱말 이름 유지, 없으면 일반 이름');
// STK: 스택은 고르지 않고 보여 주기만(install.js detect)
assert.ok(!/--stack/.test(wiz), '마법사는 --stack을 넘기지 않는다');
assert.ok(/' detect --project '/.test(wiz), '마법사는 install.js detect로 검증 명령을 보여 준다');
assert.ok(/cmd === 'detect'/.test(js), 'install.js에 detect 명령');
// D-39 ③: 기본 접두사는 lib/projects.js freePrefix와 같은 규칙(다른 프로젝트 목록은 install.js projects로 한 번 읽음). 함수만 떼어 PowerShell로 돌린다(목록은 미리 넣어 node를 부르지 않음)
assert.ok(/' projects'/.test(wiz) && /cmd === 'projects'/.test(js), '마법사는 install.js projects로 다른 프로젝트 접두사를 읽는다');
{
  const fnText = (name) => {
    const m = new RegExp('^function ' + name + '\\b[\\s\\S]*?^\\}', 'm').exec(wiz);
    assert.ok(m, name);
    return m[0];
  };
  const prefixOf = (name, project) => {
    const script = [
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $Demo = $false",
      "$script:Projects = @([pscustomobject]@{ dir = 'C:\\w\\erp'; rolePrefix = 'ER-' }, [pscustomobject]@{ dir = 'C:/w/erp2'; rolePrefix = 'erp-' }, [pscustomobject]@{ dir = 'C:\\w\\other'; rolePrefix = $null; pmRole = 'OT-pm' })",
      fnText('Get-OtherPrefixes'), fnText('Get-PrefixFor'),
      "$St = @{ Project = '" + project + "' }; Get-PrefixFor '" + name + "'",
    ].join('\n');
    const out = spawnSync(POWERSHELL, ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  assert.strictEqual(prefixOf('erp-new', 'C:\\w\\new'), 'ER2-', 'ER-·ERP-가 겹치면 숫자');
  assert.strictEqual(prefixOf('my-app', 'C:\\w\\new'), 'MY-');
  assert.strictEqual(prefixOf('other2', 'C:\\w\\new'), 'OTH-', 'pmRole 앞부분과도 겹침');
  assert.strictEqual(prefixOf('erp', 'C:\\W\\ERP\\.claude\\worktrees\\ER-dev'), 'ER-', '자기 프로젝트(worktree 안이어도, 대소문자 무시)는 뺌');
  assert.strictEqual(prefixOf('erp', "  \"C:\\w\\erp\\\" "), 'ER-', '따옴표·공백 친 경로도 자기 프로젝트');
  // 목록 읽기에 실패하면(Node.js 설치 전 등) 기억하지 않아 다음에 다시 읽는다
  const retry = spawnSync(POWERSHELL, ['-NoProfile', '-Command', [
    "$Demo = $false; $Pkg = 'C:\\nowhere'; $script:Projects = $null; function Q($s) { $s }; function Write-Log($m) { }",
    fnText('Get-OtherPrefixes'),
    "$env:PATH = ''; $null = Get-OtherPrefixes 'C:\\w\\new'; if ($null -eq $script:Projects) { 'retry' } else { 'cached' }",
  ].join('\n')], { encoding: 'utf8' });
  assert.strictEqual(retry.stdout.trim(), 'retry', retry.stdout + retry.stderr);
}
// 6. 새 PC 시험(2026-10-23): 점검 전 PATH 다시 읽기, 'tools' 실패는 이름 + 새 창에서 다시 점검, pm 시작은 시간 제한, 출력이 안 닫혀도 끝남
{
  const fnText = (name) => {
    const m = new RegExp('^function ' + name + '\\b[\\s\\S]*?^\\}', 'm').exec(wiz);
    assert.ok(m, name);
    return m[0];
  };
  const runPs = (lines) => {
    const out = spawnSync(POWERSHELL, ['-NoProfile', '-Command', ['[Console]::OutputEncoding = [Text.Encoding]::UTF8', ...lines].join('\n')], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(out.status, 0, out.stdout + out.stderr);
    return out.stdout.trim();
  };
  assert.ok(/\$St\.Waiting = 'doctor'\r?\n\s*if \(-not \$Demo\) \{ Update-PathFromRegistry \}/.test(fnText('Start-Doctor')), '점검 전에 PATH를 레지스트리에서 다시 읽음');
  assert.ok(/^\s*\} \$PmLimit\r?$/m.test(fnText('Start-Pm')) && /^\$PmLimit = 90\b/m.test(wiz), 'pm 시작은 시간 제한을 걸고 부른다');
  // 'tools': 점검 원문에서 프로그램 이름만, 할 일은 새 창에서 다시 점검(명령 포함)
  const tools = runPs([
    wiz.match(/^function QP\b.*$/m)[0], "$St = @{ Project = 'C:\\w\\my $app' }",
    fnText('Get-FriendlyLine'),
    "$it = Get-FriendlyLine @{ id = 'tools'; detail = '없음: code(VS Code, PATH), claude(Claude Code CLI)' } '프로그램 설치'",
    "$it.Head; $it.Do; $it.Cmd",
  ]).split(/\r?\n/);
  assert.ok(/: VS Code, Claude Code$/.test(tools[0]) && !/Git|Node/.test(tools[0]), tools.join('\n'));
  assert.ok(/새로 열어/.test(tools[1]) && !/setup을 다시/.test(tools[1]), tools.join('\n'));
  assert.strictEqual(tools[2], 'powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\\.wy-tools\\wy-ops\\current\\install.ps1" doctor --project \'C:\\w\\my $app\'', '붙여 넣는 명령의 경로는 작은따옴표($가 풀리지 않게)');
  assert.ok(/^function Go-Step[^\n]*\n[^\n]*\n[^\n]*\n\s*if \(\$n -ne 7 -and \$St\.PmPhase -eq 'run'\) \{ \$St\.PmPhase = 'fail' \}/m.test(wiz), 'pm 시작 중 다른 단계로 가면 실패로 둔다(돌아왔을 때 시작하는 중에 머물지 않게)');
  // 기다리는 명령의 시간 제한(Start-Poll $limit): 안 넘으면 그대로, 넘으면 명령을 멈추고 onDone을 시간 초과로 부른다
  const poll = runPs([
    "$script:stopped = 0; function Stop-Hidden($r) { $script:stopped++ }; function Write-Log($s) { }",
    "function Start-Hidden($c) { @{ Exit = $null; Lines = @('a'); Cmd = $c } }; function Read-Hidden($r) { }",
    wiz.match(/^function Start-Poll\b.*$/m)[0], fnText('Read-Poll'),
    "$St = @{}; Start-Poll 'x' { param($code, $out, $late) $script:got = \"$code|$out|$late\" } 90; Read-Poll; $null -ne $St.Poll",
    "$St.Poll.Until = (Get-Date).AddSeconds(-1); Read-Poll; $script:got; $script:stopped; $null -eq $St.Poll",
  ]).split(/\r?\n/);
  assert.deepStrictEqual(poll, ['True', '|a|True', '1', 'True'], poll.join('\n'));
  assert.ok(/\$St\.PmPhase = if \(\$late\) \{ 'late' \}/.test(fnText('Start-Pm')) && /\$St\.PmPhase -eq 'late'/.test(fnText('Show-Step7')), 'pm 시간 초과는 late로 따로 보인다');
  assert.ok(/'명령 복사' \{ \[Windows\.Forms\.Clipboard\]::SetText\(\$St\.PmCmd\) \}/.test(wiz) && /\$St\.PmCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File '/.test(wiz), 'pm 실패 안내에 붙여 넣을 명령');
  // 끝난 명령이 띄운 오래 사는 프로세스가 출력 핸들을 쥐고 있어도(처음 뜨는 claude daemon 등) 몇 초 뒤 끝난 것으로 본다
  //   (ping이 약 8초 출력 핸들을 쥔다. 이 시험 프로세스의 출력도 물려받으므로 걸린 시간은 PowerShell 안에서 재고, 끝에 그 ping을 끈다)
  const hidden = runPs([
    "function Write-Log($s) { }", fnText('Start-Hidden'), fnText('Read-Hidden'),
    "$t0 = Get-Date; $r = Start-Hidden 'echo hi& start /b ping -n 9 127.0.0.79' $env:TEMP",
    "$end = (Get-Date).AddSeconds(12); while ($null -eq $r.Exit -and (Get-Date) -lt $end) { [void](Read-Hidden $r); Start-Sleep -Milliseconds 200 }",
    "\"$($r.Exit)|$($r.Lines[0])|$([int]((Get-Date) - $t0).TotalSeconds)\"",
    "Get-CimInstance Win32_Process -Filter \"Name='PING.EXE' and CommandLine like '%127.0.0.79%'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
  ]).split('|');
  assert.deepStrictEqual(hidden.slice(0, 2), ['0', 'hi'], hidden.join('|'));
  assert.ok(Number(hidden[2]) < 6, `출력이 닫히기(약 8초)를 기다리지 않음: ${hidden[2]}초`);
}
console.log('설치 마법사 검사 통과');
