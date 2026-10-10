// session.ps1 attach <역할>·start-pm·pm-cmd: attach는 이름으로 실행 중인 백그라운드 세션 id를 찾아 claude attach(pm 역할 agent:false도 됨), start-pm은 pm을 백그라운드로
//   node test/sessionAttach.test.js   임시 저장소·가짜 claude(PATH 앞에 둔 claude.cmd)만. 실제 세션은 건드리지 않음
//   WY_OPS_DIRECT=1: ssh(세션 0)에서 돌려도 작업 스케줄러를 거치지 않고 가짜 claude를 바로 부른다
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
    'if "%1"=="--bg" echo BG %* & exit /b 0',
    'echo UNEXPECTED %* & exit /b 1',
  ].join('\r\n'));
  const ps = (args) => {
    const cmd = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; & '${path.join(scripts, 'session.ps1')}' ${args.join(' ')}`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, WY_OPS_DIRECT: '1' },
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

  // pm-cmd: 원격 운용 순서(start-pm -Force → 이전 pm 종료 → attach)와 예전 대화형 한 줄
  out = ps(['pm-cmd', `'${handoff}'`]);
  assert.ok(out.includes(`start-pm '${hp}' -Force`) && /attach AB-pm/.test(out) && out.includes(`claude.cmd --name AB-pm "/ecc:resume-session ${hp}"`), `pm-cmd 안내\n${out}`);
} finally {
  rmTree(tmp);
}
console.log('sessionAttach.test.js 통과');
