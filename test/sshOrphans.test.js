// templates/connect/ssh-orphans.ps1 판정·끄기 순서 검사: 가짜 프로세스 목록(-FixtureJson)으로 돈다. 실제 프로세스는 끄지 않는다.
//   node test/sshOrphans.test.js   (Windows 전용, 아니면 건너뜀)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('wy-ops ssh-orphans 검사 건너뜀(Windows 아님)');
  process.exit(0);
}

const SCRIPT = path.join(__dirname, '..', 'templates', 'connect', 'ssh-orphans.ps1');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-orphans-'));
const MB = 100 * 1024 * 1024;
const CODE = 'code-2a59476c9bfcb90b3ddc372c36762471b7dfad1c.exe';
const at = (hm, s = 0) => `2026-10-12T${hm}:${String(s).padStart(2, '0')}`;
const P = (id, ppid, name, created) => ({ ProcessId: id, ParentProcessId: ppid, Name: name, CreationDate: created, WorkingSetSize: MB });
// PowerShell 3단 + code CLI(접속 하나가 남기는 모양). 생성 시각은 1초씩 늦게
const chain = (root, ppid, hm, extra = []) => [
  P(root, ppid, 'powershell.exe', at(hm, 0)),
  P(root + 1, root, 'powershell.exe', at(hm, 1)),
  P(root + 2, root + 1, 'powershell.exe', at(hm, 2)),
  P(root + 3, root + 2, CODE, at(hm, 3)),
  P(root + 4, root, 'conhost.exe', at(hm, 4)),
  ...extra,
];

const processes = [
  P(4, 0, 'System', at('00:00')),
  P(900, 4, 'sshd.exe', at('03:00')),
  P(1000, 900, 'sshd-session.exe', at('13:00')),
  ...chain(1001, 1000, '13:01'), // 살아 있는 접속
  ...chain(2001, 9999, '11:41'), // 끊긴 접속(부모 없음) → 후보
  ...chain(3001, 9998, '13:01', [P(3010, 3004, 'cmd.exe', at('13:01', 10)), P(3011, 3010, 'node.exe', at('13:01', 11))]), // 서버를 품음
  ...chain(4001, 9997, '10:00', [P(4010, 4004, CODE, at('10:00', 10))]), // 옛 supervisor 모양(code 아래 code) → 후보
  ...chain(5001, 9996, '11:50', [P(5010, 5004, CODE, at('11:50', 10))]), // 최신 supervisor → 남김
  ...chain(6001, 9995, '13:20'), // 10분 전 → too-new
  P(8000, 4, 'notepad.exe', at('13:25')), // pid 재사용: 7001의 부모 번호를 나중에 생긴 프로세스가 씀
  ...chain(7001, 8000, '12:00'), // → 부모 없음으로 보고 후보
  P(9001, 9994, 'powershell.exe', at('09:00')), // code 없는 묶음 → 보지 않음
  P(9002, 9001, 'conhost.exe', at('09:00', 1)),
  P(9500, 4, 'node.exe', at('08:00')), // 다른 프로그램이 띄운 PowerShell → parent-alive
  ...chain(9501, 9500, '08:30'),
];
const fixture = path.join(base, 'procs.json');
fs.writeFileSync(fixture, JSON.stringify({ now: at('13:30'), serverPids: [3010], processes }));

function run(...args) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-FixtureJson', fixture, '-Json', ...args], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().replace(/^﻿/, ''));
}
const byRoot = (o) => Object.fromEntries(o.chains.map((c) => [c.rootPid, c]));

try {
  // 판정
  const o = run();
  const c = byRoot(o);
  assert.deepStrictEqual(Object.keys(c).map(Number).sort((a, b) => a - b), [1001, 2001, 3001, 4001, 5001, 6001, 7001, 9501], '묶음 목록(code 없는 9001은 빠짐)');
  assert.strictEqual(c[1001].reason, 'live-ssh');
  assert.strictEqual(c[3001].reason, 'server');
  assert.strictEqual(c[5001].reason, 'agent-host-supervisor', '최신 supervisor만 남김');
  assert.strictEqual(c[6001].reason, 'too-new');
  assert.strictEqual(c[9501].reason, 'parent-alive:node.exe');
  for (const id of [2001, 4001, 7001]) assert.strictEqual(c[id].verdict, 'candidate', `${id} 후보`);
  assert.deepStrictEqual(c[2001].pids.slice().sort(), [2001, 2002, 2003, 2004, 2005]);
  assert.strictEqual(c[2001].mb, 500);
  assert.deepStrictEqual(o.candidates, { count: 3, mb: 500 + 600 + 500 });
  assert.strictEqual(o.stopped, null, '판정만이면 stopped 없음');
  assert.strictEqual(o.stoppedChains, null, '판정만이면 stoppedChains 없음');
  assert.strictEqual(o.minAgeMinutes, 30);

  // 서버 pid.txt가 바뀌면(서버가 다른 묶음으로) 3001은 일하는 프로세스로 남는다
  fs.writeFileSync(fixture, JSON.stringify({ now: at('13:30'), serverPids: [], processes }));
  assert.strictEqual(byRoot(run())[3001].reason, 'has-worker');

  // 나이 기준은 매개변수
  assert.strictEqual(byRoot(run('-MinAgeMinutes', '5'))[6001].verdict, 'candidate');

  // -Stop(가짜 목록이면 끄지 않고 순서만): 후보 묶음만, 깊은 것부터, 맨 위 PowerShell은 마지막
  const s = run('-Stop');
  const stopped = s.stopped.map((x) => x.pid);
  assert.deepStrictEqual(stopped.slice().sort((a, b) => a - b), [2001, 2002, 2003, 2004, 2005, 4001, 4002, 4003, 4004, 4005, 4010, 7001, 7002, 7003, 7004, 7005]);
  const order2001 = stopped.filter((p) => p >= 2001 && p <= 2005);
  assert.deepStrictEqual(order2001, [2004, 2003, 2005, 2002, 2001], '깊은 것부터, 같은 깊이는 늦게 생긴 것부터');
  assert.ok(stopped.indexOf(4010) < stopped.indexOf(4004), 'code 아래 code가 먼저');
  assert.ok(s.stopped.every((x) => x.ok === true));
  // 세션 현황 결과 한 줄(0.11.0): 다시 판정해도 후보라 끈 묶음 수·MB
  assert.deepStrictEqual(s.stoppedChains, { count: 3, mb: 1600 });

  // 후보가 없으면 0묶음(30분 기준을 크게 잡아 모두 too-new)
  const none = run('-Stop', '-MinAgeMinutes', '100000');
  assert.deepStrictEqual(none.stoppedChains, { count: 0, mb: 0 });
  assert.deepStrictEqual(none.stopped, []);

  console.log('wy-ops ssh-orphans 검사 통과');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
