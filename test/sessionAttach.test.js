// session.ps1 attach <역할>·start-pm·pm-cmd: attach는 이름으로 실행 중인 백그라운드 세션 id를 찾아 claude attach(pm 역할 agent:false도 됨), start-pm은 pm을 백그라운드로
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
  }));
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
  const write = (list) => fs.writeFileSync(agents, JSON.stringify(list));

  write([
    { id: 'old1', name: 'AB-pm', kind: 'background', state: 'stopped', startedAt: 1, sessionId: 'a' },
    { id: 'new2', name: 'AB-pm', kind: 'background', state: 'running', status: 'busy', pid: 102, startedAt: 2, sessionId: 'b' },
    { id: 'ide3', name: 'AB-qa', kind: 'interactive', status: 'idle', pid: 103, startedAt: 3, sessionId: 'c' },
  ]);
  let out = ps(['attach', 'AB-pm']);
  assert.ok(/ATTACH new2/.test(out), `pm 역할(agent:false)도 이름으로 최신 백그라운드 세션에 붙음\n${out}`);
  out = ps(['attach', 'AB-qa']);
  assert.ok(/AB-qa 백그라운드 세션이 실행 중이 아닙니다/.test(out) && !/ATTACH/.test(out), `백그라운드가 아니면 붙지 않음\n${out}`);
  write([{ id: 'x1', name: 'AB-commit', kind: 'background', state: 'done', startedAt: 1, sessionId: 'd' }]);
  out = ps(['attach', 'AB-commit']);
  assert.ok(/실행 중이 아닙니다. 먼저: session.ps1 start AB-commit/.test(out), `멈춘 세션\n${out}`);
  out = ps(['attach', 'WY-pm']);
  assert.ok(/역할 이름이 아닙니다: WY-pm/.test(out), `설정에 없는 이름\n${out}`);
  out = ps(['stop', 'AB-pm']);
  assert.ok(/역할 이름이 아닙니다: AB-pm/.test(out), `pm 예외는 attach에만\n${out}`);

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
  // pid가 없으면 state가 무엇이든 멈춘 것
  write([{ id: 'q2', name: 'AB-qa', kind: 'background', state: 'working', startedAt: 1, sessionId: 'i' }]);
  out = ps(['stop', 'AB-qa']);
  assert.ok(/실행 중이 아닙니다/.test(out) && !/STOP/.test(out), `pid 없으면 멈춘 것\n${out}`);

  // start-pm: 백그라운드 pm이 없으면 pmRole 이름으로 --bg(역할 파일 없이), 인수인계 경로를 시작 지시에
  const handoff = path.join(tmp, '2026-10-10-AB-pm-session.tmp');
  fs.writeFileSync(handoff, 'x');
  const hp = handoff.replace(/\\/g, '/');
  write([{ id: 'ide1', name: 'AB-pm', kind: 'interactive', status: 'idle', pid: 101, startedAt: 1, sessionId: 'e' }]);
  out = ps(['start-pm', `'${handoff}'`]);
  assert.ok(/BG --bg --name AB-pm /.test(out) && !/--agent/.test(out), `pm은 --agent 없이 --bg\n${out}`);
  assert.ok(out.includes(`/ecc:resume-session ${hp}`) && /ListAgents/.test(out) && /pm-ops/.test(out), `시작 지시: 인수인계·pm-ops·ListAgents\n${out}`);
  assert.ok(/대화형 세션\(ide1\)의 창을 닫으세요/.test(out), `이전 대화형 pm 안내\n${out}`);
  out = ps(['start-pm']);
  assert.ok(/BG --bg --name AB-pm /.test(out) && !/resume-session/.test(out), `인수인계 없이\n${out}`);
  out = ps(['start-pm', `'${path.join(tmp, 'none-such.tmp')}'`]);
  assert.ok(/인수인계 파일이 없습니다/.test(out) && !/BG /.test(out), `없는 경로는 거부\n${out}`);
  // 이미 백그라운드 pm이 돌면 거부, -Force면 띄우고 이전 것을 멈추라고 알림
  write([{ id: 'bg9', name: 'AB-pm', kind: 'background', state: 'blocked', status: 'idle', pid: 105, startedAt: 5, sessionId: 'f' }]);
  out = ps(['start-pm', `'${handoff}'`]);
  assert.ok(/이미 실행 중입니다\(bg9\)/.test(out) && !/BG /.test(out), `실행 중이면 거부\n${out}`);
  out = ps(['start-pm', `'${handoff}'`, '-Force']);
  assert.ok(/BG --bg --name AB-pm /.test(out) && /claude stop bg9/.test(out), `-Force: 띄우고 이전 pm 멈추기 안내\n${out}`);

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
  assert.ok(/BG --bg --name AB-pm /.test(out), `띄움\n${out}`);
  assert.strictEqual(/바탕화면이 아닌 로그온\(유형 \d+/.test(out), !['2', '10', '11'].includes(lt), `로그온 유형 ${lt}에 맞는 경고\n${out}`);
  if (!['2', '10', '11'].includes(lt)) assert.ok(out.includes('claude daemon stop --any') && out.includes('Start-ScheduledTask wy-ops-test-no-such-task'), `옮기는 방법 안내\n${out}`);
  // lock의 pid를 claude가 아닌 프로그램이 쓰고 있으면(pid 재사용) daemon 없음으로 보고 경고하지 않는다
  out = ps(['start-pm'], { WY_OPS_DAEMON_NAME: 'claude.exe' });
  assert.ok(/BG --bg --name AB-pm /.test(out) && !/바탕화면이 아닌 로그온/.test(out), `pid 재사용은 daemon 없음\n${out}`);
  out = ps(['start-pm'], { WY_OPS_DAEMON_LOCK: path.join(tmp, 'none.lock') });
  assert.ok(/BG --bg --name AB-pm /.test(out) && !/로그온 작업/.test(out), `daemon·작업 없음\n${out}`);

  // pm-cmd: 원격 운용 순서(start-pm -Force → 이전 pm 종료 → attach)와 예전 대화형 한 줄
  out = ps(['pm-cmd', `'${handoff}'`]);
  assert.ok(out.includes(`start-pm '${hp}' -Force`) && /attach AB-pm/.test(out) && out.includes(`claude.cmd --name AB-pm "/ecc:resume-session ${hp}"`), `pm-cmd 안내\n${out}`);
} finally {
  rmTree(tmp);
}
console.log('sessionAttach.test.js 통과');
