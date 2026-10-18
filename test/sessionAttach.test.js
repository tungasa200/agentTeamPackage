// session.ps1 attach <역할>·start-pm·pm-cmd: attach는 이름으로 실행 중인 백그라운드 세션 id를 찾아 claude attach(pm 역할도 됨), start-pm은 pm을 역할 파일(--agent)로 백그라운드로(D-36)
//   node test/sessionAttach.test.js   임시 저장소·가짜 claude(PATH 앞에 둔 claude.cmd)만. 실제 세션은 건드리지 않음
//   WY_OPS_DAEMON_LOCK·WY_OPS_DAEMON_TASK·WY_OPS_DAEMON_NAME(node.exe): daemon 점검이 실제 ~/.claude/daemon.lock·로그온 작업 대신 임시 파일·없는 작업 이름을 본다
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rmTree } = require('../lib/fsx');

const PKG = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-attach-'));
try {
  const scripts = path.join(tmp, 'repo', '.claude', 'skills', 'pm-ops', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(path.join(PKG, 'templates', 'pm-ops', 'scripts', 'session.ps1'), path.join(scripts, 'session.ps1'));
  fs.writeFileSync(path.join(tmp, 'repo', '.claude', 'wy-ops.json'), JSON.stringify({
    rolePrefix: 'AB-', pmRole: 'AB-pm', commitRole: 'AB-commit',
    roles: [{ name: 'AB-commit', agent: true }, { name: 'AB-pm', agent: false }, { name: 'AB-qa', agent: true }],
    worktree: { enabled: false }, // 임시 저장소는 git이 아님. worktree는 sessionWorktree.test.js가 본다
  })); // pm agent:false는 D-36 전 설치 모양(뒤에서 agent:true인 새 설치 모양도 본다)
  // 가짜 claude: agents --json --all이면 목록, attach면 받은 id를 출력
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const agents = path.join(tmp, 'agents.json');
  fs.writeFileSync(path.join(bin, 'claude.cmd'), [
    '@echo off',
    `if "%1"=="agents" type "${agents}" & exit /b 0`,
    'if "%1"=="attach" echo ATTACH %2 & exit /b 0',
    'if "%1"=="stop" echo STOP %2 & exit /b 0',
    'if "%1"=="rm" echo RM %2 & exit /b 0',
    'if "%1"=="--bg" if defined FAKE_BG_FAIL echo BGFAIL %* & exit /b 1',
    'if "%1"=="--bg" echo BG %* & exit /b 0',
    'echo UNEXPECTED %* & exit /b 1',
  ].join('\r\n'));
  // daemon.lock 대신: 살아 있는 이 node 프로세스의 pid(그래서 로그온 작업을 시작하려 하지 않음)
  const lock = path.join(tmp, 'daemon.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const ps = (args, env = {}) => {
    const cmd = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; & '${path.join(scripts, 'session.ps1')}' ${args.join(' ')}`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, WY_OPS_DAEMON_LOCK: lock, WY_OPS_DAEMON_TASK: 'wy-ops-test-no-such-task', WY_OPS_DAEMON_NAME: path.basename(process.execPath), ...env },
    });
    return (r.stdout || '') + (r.stderr || '');
  };
  // 세션은 이 저장소에서 띄운 것으로(cwd). 이름 접두사·작업 폴더가 다른 세션은 따로 시험(MP-01)
  const repoDir = path.join(tmp, 'repo');
  const write = (list) => fs.writeFileSync(agents, JSON.stringify(list.map((x) => ({ cwd: repoDir, ...x }))));

  // MP-01: 이 프로젝트 세션만(이름 접두사 AND 작업 폴더가 저장소이거나 그 아래, 대소문자·슬래시 무시)
  write([
    { id: 'mine1', name: 'AB-qa', kind: 'background', state: 'done', status: 'idle', pid: 11, startedAt: 1, sessionId: 's1' },
    { id: 'mine2', name: 'ab-commit', kind: 'background', state: 'done', startedAt: 1, sessionId: 's2', cwd: path.join(repoDir, '.claude', 'worktrees', 'x').replace(/\\/g, '/').toUpperCase() },
    { id: 'other1', name: 'WY-pm', kind: 'background', state: 'done', status: 'idle', pid: 12, startedAt: 1, sessionId: 's3' },
    { id: 'other2', name: 'AB-pm', kind: 'background', state: 'done', status: 'idle', pid: 13, startedAt: 9, sessionId: 's4', cwd: path.join(tmp, 'repo2') },
    { id: 'other3', name: 'AB-dev', kind: 'background', state: 'done', startedAt: 1, sessionId: 's5', cwd: repoDir + '-copy' },
  ]);
  let out = ps(['list']);
  assert.ok(/mine1/.test(out) && /mine2/.test(out), `이 프로젝트 세션은 보임\n${out}`);
  assert.ok(!/other1|other2|other3/.test(out), `다른 접두사·다른 폴더(이름이 같거나 앞부분만 같은 폴더도)는 안 보임\n${out}`);
  out = ps(['attach', 'AB-pm']);
  assert.ok(/실행 중이 아닙니다/.test(out) && !/ATTACH/.test(out), `다른 프로젝트의 같은 이름 세션에 붙지 않음\n${out}`);
  out = ps(['health']);
  assert.ok(/AB-pm\s+없음/.test(out) && /AB-qa\s+idle/.test(out), `health도 이 프로젝트만\n${out}`);

  write([
    { id: 'old1', name: 'AB-pm', kind: 'background', state: 'stopped', startedAt: 1, sessionId: 'a' },
    { id: 'new2', name: 'AB-pm', kind: 'background', state: 'running', status: 'busy', pid: 102, startedAt: 2, sessionId: 'b' },
    { id: 'ide3', name: 'AB-qa', kind: 'interactive', status: 'idle', pid: 103, startedAt: 3, sessionId: 'c' },
  ]);
  // list: 같은 이름이 둘이어도 멈춘 항목(pid 없음, pm 교체 직후 이전 pm)은 중복으로 세지 않음
  out = ps(['list']);
  assert.ok(/old1/.test(out) && /new2/.test(out) && !/중복 실행/.test(out), `멈춘 이전 pm은 중복 아님\n${out}`);
  out = ps(['attach', 'AB-pm']);
  assert.ok(/ATTACH new2/.test(out), `pm 역할도 이름으로 최신 백그라운드 세션에 붙음\n${out}`);
  out = ps(['attach', 'AB-qa']);
  assert.ok(/AB-qa 백그라운드 세션이 실행 중이 아닙니다/.test(out) && !/ATTACH/.test(out), `백그라운드가 아니면 붙지 않음\n${out}`);
  write([{ id: 'x1', name: 'AB-commit', kind: 'background', state: 'done', startedAt: 1, sessionId: 'd' }]);
  out = ps(['attach', 'AB-commit']);
  assert.ok(/실행 중이 아닙니다. 먼저: session.ps1 start AB-commit/.test(out), `멈춘 세션\n${out}`);
  out = ps(['attach', 'WY-pm']);
  assert.ok(/역할 이름이 아닙니다: WY-pm/.test(out), `설정에 없는 이름\n${out}`);
  for (const c of ['start', 'rotate', 'prep']) {
    out = ps([c, 'AB-pm']);
    assert.ok(/AB-pm 은 start-pm을 쓰세요/.test(out) && !/BG /.test(out), `pm은 ${c} 대신 start-pm\n${out}`);
  }

  // 살아 있음은 pid로 본다: 턴을 마치고 쉬는 백그라운드 세션도 state=done을 내지만 pid·status가 있다(2026-10-10 stop 회귀)
  write([
    { id: 'q1', name: 'AB-qa', kind: 'background', state: 'done', status: 'idle', pid: 201, startedAt: 2, sessionId: 'g' },
    { id: 'c1', name: 'AB-commit', kind: 'background', state: 'blocked', status: 'idle', pid: 202, startedAt: 2, sessionId: 'h' },
  ]);
  out = ps(['stop', 'AB-qa']);
  assert.ok(/STOP q1/.test(out) && !/실행 중이 아닙니다/.test(out), `쉬는 세션(state=done, pid 있음)도 멈춤\n${out}`);
  out = ps(['attach', 'AB-commit']);
  assert.ok(/ATTACH c1/.test(out), `state=blocked, pid 있음은 살아 있음\n${out}`);
  out = ps(['start', 'AB-qa']);
  assert.ok(/이미 실행 중입니다\(q1\)/.test(out) && !/BG /.test(out), `쉬는 세션을 다시 띄우지 않음\n${out}`);
  out = ps(['health']);
  assert.ok(/AB-qa\s+idle/.test(out), `health는 살아 있으면 status\n${out}`);
  assert.ok(/AB-pm\s+없음/.test(out) && out.indexOf('AB-pm') < out.indexOf('AB-commit'), `health에 pm 줄(맨 위)\n${out}`);
  // pm 멈춤(0.10.0, 세션 현황 [멈춤]): 이름으로 최신 백그라운드 pm
  // 실행 중(pid 있음) 같은 이름이 둘이면 list가 '중복 실행'
  write([
    { id: 'p1', name: 'AB-pm', kind: 'background', status: 'busy', pid: 201, startedAt: 1, sessionId: 'p1' },
    { id: 'p2', name: 'AB-pm', kind: 'background', status: 'idle', pid: 202, startedAt: 2, sessionId: 'p2' },
  ]);
  out = ps(['list']);
  assert.ok(/중복 실행: AB-pm \(p1, p2\)/.test(out), `실행 중 둘이면 중복\n${out}`);
  write([{ id: 'pm7', name: 'AB-pm', kind: 'background', state: 'done', status: 'idle', pid: 207, startedAt: 2, sessionId: 'p7' }]);
  out = ps(['stop', 'AB-pm']);
  assert.ok(/STOP pm7/.test(out), `pm도 stop\n${out}`);
  out = ps(['health']);
  assert.ok(/AB-pm\s+idle/.test(out), `health pm 상태\n${out}`);
  // pid가 없으면 state가 무엇이든 멈춘 것
  write([{ id: 'q2', name: 'AB-qa', kind: 'background', state: 'working', startedAt: 1, sessionId: 'i' }]);
  out = ps(['stop', 'AB-qa']);
  assert.ok(/실행 중이 아닙니다/.test(out) && !/STOP/.test(out), `pid 없으면 멈춘 것\n${out}`);

  // start-pm(D-36): 역할 파일(.claude/agents/<pm>.md)이 없으면 gen 먼저로 멈춤
  const handoff = path.join(tmp, '2026-10-10-AB-pm-session.tmp');
  fs.writeFileSync(handoff, 'x');
  const hp = handoff.replace(/\\/g, '/');
  write([{ id: 'ide1', name: 'AB-pm', kind: 'interactive', status: 'idle', pid: 101, startedAt: 1, sessionId: 'e' }]);
  out = ps(['start-pm', `'${handoff}'`]);
  assert.ok(/역할 파일\(\.claude\/agents\/AB-pm\.md\)이 없습니다/.test(out) && /install\.ps1 gen/.test(out) && !/BG /.test(out), `역할 파일 없으면 멈춤\n${out}`);
  fs.mkdirSync(path.join(repoDir, '.claude', 'agents'));
  fs.writeFileSync(path.join(repoDir, '.claude', 'agents', 'AB-pm.md'), '---\nname: AB-pm\n---\n');
  // 백그라운드 pm이 없으면 --agent <pm>으로 --bg, 시작 지시는 인수인계 경로 한 줄(시작 규칙은 역할 파일에)
  out = ps(['start-pm', `'${handoff}'`]);
  assert.ok(out.includes(`BG --bg --agent AB-pm --name AB-pm "[AB-pm 시작] 인수인계: ${hp}"`), `pm은 --agent로 --bg, 인수인계 한 줄\n${out}`);
  assert.ok(/이전 AB-pm 을 멈추세요: claude stop ide1/.test(out) && !/창을 닫으세요/.test(out), `이전 pm은 종류와 상관없이 claude stop\n${out}`);
  out = ps(['start-pm']);
  assert.ok(out.includes('BG --bg --agent AB-pm --name AB-pm "[AB-pm 시작] 인수인계 없음"'), `인수인계 없이\n${out}`);
  // start-pm latest(0.10.0): 가장 최근 pm 인수인계(USERPROFILE의 .claude/session-data), 없으면 인수인계 없이
  const home = path.join(tmp, 'home');
  const sd = path.join(home, '.claude', 'session-data');
  fs.mkdirSync(sd, { recursive: true });
  out = ps(['start-pm', 'latest'], { USERPROFILE: home });
  assert.ok(/인수인계: 없음/.test(out) && /BG --bg --agent AB-pm --name AB-pm /.test(out) && /인수인계 없음"/.test(out), `latest, 인수인계 없음\n${out}`);
  const older = path.join(sd, '2026-10-09-AB-pm-session.tmp');
  const newer = path.join(sd, '2026-10-10-AB-pm-2-session.tmp');
  fs.writeFileSync(older, 'x');
  fs.writeFileSync(newer, 'x');
  fs.writeFileSync(path.join(sd, '2026-10-11-AB-qa-session.tmp'), 'x');
  fs.utimesSync(older, new Date(2026, 9, 9), new Date(2026, 9, 9));
  out = ps(['start-pm', 'latest'], { USERPROFILE: home });
  assert.ok(out.includes(`인수인계: ${newer.replace(/\\/g, '/')}`), `latest는 가장 최근 pm 인수인계(다른 역할 제외)\n${out}`);
  out = ps(['start-pm', `'${path.join(tmp, 'none-such.tmp')}'`]);
  assert.ok(/인수인계 파일이 없습니다/.test(out) && !/BG /.test(out), `없는 경로는 거부\n${out}`);
  // 이미 백그라운드 pm이 돌면 거부, -Force면 띄우고 이전 것을 멈추라고 알림
  write([{ id: 'bg9', name: 'AB-pm', kind: 'background', state: 'blocked', status: 'idle', pid: 105, startedAt: 5, sessionId: 'f' }]);
  out = ps(['start-pm', `'${handoff}'`]);
  assert.ok(/이미 실행 중입니다\(bg9\)/.test(out) && !/BG /.test(out), `실행 중이면 거부\n${out}`);
  out = ps(['start-pm', `'${handoff}'`, '-Force']);
  assert.ok(/BG --bg --agent AB-pm --name AB-pm /.test(out) && /claude stop bg9/.test(out), `-Force: 띄우고 이전 pm 멈추기 안내\n${out}`);

  // claude --bg가 실패(종료 코드≠0)하면 성공 문구 없이 실패를 알린다(0.8.2). rotate는 이전 세션을 이미 지웠다고 이어 띄우는 명령까지
  const fail = { FAKE_BG_FAIL: '1' };
  write([{ id: 'q5', name: 'AB-qa', kind: 'background', state: 'blocked', status: 'idle', pid: 301, startedAt: 1, sessionId: 'sid-q5' }]);
  out = ps(['rotate', 'AB-qa', 'none'], fail);
  assert.ok(/BGFAIL --bg --agent AB-qa/.test(out), `rotate: (멈추고 지운 뒤) 띄우기 시도\n${out}`);
  assert.ok(/백그라운드 시작 실패\(종료 코드 1\)/.test(out) && /이미 멈추고 목록에서 지웠습니다/.test(out) && out.includes('claude --bg --resume sid-q5 --name AB-qa'), `rotate 실패 안내\n${out}`);
  assert.ok(!/세션을 교체했습니다/.test(out), `실패면 성공 문구 없음\n${out}`);
  out = ps(['rotate', 'AB-qa', 'none']);
  assert.ok(/BG --bg --agent AB-qa/.test(out) && /세션을 교체했습니다/.test(out), `성공이면 그대로\n${out}`);
  write([]);
  out = ps(['start-pm'], fail);
  assert.ok(/백그라운드 시작 실패/.test(out) && !/백그라운드 AB-pm 을 띄웠습니다/.test(out), `start-pm 실패\n${out}`);
  out = ps(['start', 'AB-qa', "'일'"], fail);
  assert.ok(/백그라운드 시작 실패/.test(out) && !/새 세션으로 띄웠습니다/.test(out), `start 실패\n${out}`);
  out = ps(['adopt', 'AB-qa', 'sid-x'], fail);
  assert.ok(/백그라운드 시작 실패/.test(out) && !/옮겼습니다\. 답을 마치면/.test(out), `adopt 실패\n${out}`);
  // daemon 점검(D-167): daemon이 바탕화면이 아닌 로그온(ssh 등)이면 경고만 하고 띄운다. daemon이 없고 로그온 작업도 없으면 그냥 띄운다
  const lt = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimAssociatedInstance -InputObject (Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}') -ResultClassName Win32_LogonSession).LogonType`], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  out = ps(['start-pm']);
  assert.ok(/BG --bg --agent AB-pm --name AB-pm /.test(out), `띄움\n${out}`);
  assert.strictEqual(/바탕화면이 아닌 로그온\(유형 \d+/.test(out), !['2', '10', '11'].includes(lt), `로그온 유형 ${lt}에 맞는 경고\n${out}`);
  if (!['2', '10', '11'].includes(lt)) assert.ok(out.includes('claude daemon stop --any') && out.includes('Start-ScheduledTask wy-ops-test-no-such-task'), `옮기는 방법 안내\n${out}`);
  // lock의 pid를 claude가 아닌 프로그램이 쓰고 있으면(pid 재사용) daemon 없음으로 보고 경고하지 않는다
  out = ps(['start-pm'], { WY_OPS_DAEMON_NAME: 'claude.exe' });
  assert.ok(/BG --bg --agent AB-pm --name AB-pm /.test(out) && !/바탕화면이 아닌 로그온/.test(out), `pid 재사용은 daemon 없음\n${out}`);
  out = ps(['start-pm'], { WY_OPS_DAEMON_LOCK: path.join(tmp, 'none.lock') });
  assert.ok(/BG --bg --agent AB-pm --name AB-pm /.test(out) && !/로그온 작업/.test(out), `daemon·작업 없음\n${out}`);

  // pm-cmd: 원격 운용 순서(start-pm -Force → 이전 pm 종료 → attach)
  out = ps(['pm-cmd', `'${handoff}'`]);
  assert.ok(out.includes(`start-pm '${hp}' -Force`) && /attach AB-pm/.test(out) && /claude stop <id>/.test(out) && !/대화형|claude.cmd/.test(out), `pm-cmd 안내(대화형 잔재 없음, D-36)\n${out}`);

  // D-36 뒤 새 설치: pm이 agent:true라 역할 목록에 들어가도 health에 pm 줄은 하나, start·rotate·prep은 start-pm으로
  fs.writeFileSync(path.join(repoDir, '.claude', 'wy-ops.json'), JSON.stringify({
    rolePrefix: 'AB-', pmRole: 'AB-pm', commitRole: 'AB-commit', worktree: { enabled: false },
    roles: [{ name: 'AB-commit', agent: true }, { name: 'AB-pm', agent: true }, { name: 'AB-qa', agent: true }],
  }));
  write([]);
  out = ps(['health']);
  assert.strictEqual((out.match(/AB-pm/g) || []).length, 1, `health에 pm 줄 하나\n${out}`);
  out = ps(['start', 'AB-pm']); // 막는 조건은 agent 값을 보지 않는다(rotate·prep은 위에서 확인)
  assert.ok(/AB-pm 은 start-pm을 쓰세요/.test(out) && !/BG /.test(out), `새 설치도 pm은 start 대신 start-pm\n${out}`);
} finally {
  rmTree(tmp);
}
console.log('sessionAttach.test.js 통과');
