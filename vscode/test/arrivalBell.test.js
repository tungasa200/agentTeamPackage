// 승인 센터 새 카드 소리(진행현황 14번): 처음 목록은 울리지 않음, 새 카드 한 번, 몰려와도 한 번, 설정으로 끄기, 승인 센터 연결.
//   node tools/wy-ops/vscode/test/arrivalBell.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-bell-'));
process.env.WY_APPROVALS_DIR = path.join(base, 'approvals');
const proj = path.join(base, 'proj');
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
fs.writeFileSync(path.join(proj, '.claude', 'wy-ops.json'), JSON.stringify({ commitRole: 'WY-commit', approvals: { namespace: 'ns' } }));
const requests = path.join(process.env.WY_APPROVALS_DIR, 'ns', 'requests');
const writeReq = (id) => {
  fs.mkdirSync(requests, { recursive: true });
  fs.writeFileSync(path.join(requests, `${id}.json`), JSON.stringify({ kind: 'commit', session: 'WY-commit', createdAt: new Date().toISOString(), title: id, command: `git commit -F ${id}`, what: '커밋', why: '시험', onClick: '실행' }));
};

const { install, EXT } = require('./fakeVscode');
const { ArrivalBell, soundCommand } = require(path.join(EXT, 'arrivalBell.js'));

function bell(opts = {}) {
  const calls = [];
  let t = 0;
  const b = new ArrivalBell({ play: () => calls.push(t), now: () => t, ...opts });
  return { b, calls, at: (ms) => { t = ms; } };
}

test('처음 받은 목록은 기준만 삼고 울리지 않는다', () => {
  const { b, calls } = bell();
  assert.strictEqual(b.update(['a', 'b']), false);
  assert.strictEqual(b.update(['a', 'b']), false);
  assert.deepStrictEqual(calls, []);
});

test('새 카드가 오면 한 번, 몰려와도 한 번, 간격이 지나면 다시', () => {
  const { b, calls, at } = bell();
  b.update(['a']);
  at(10000);
  assert.strictEqual(b.update(['a', 'b', 'c']), true, '두 장이 한꺼번에 와도');
  assert.strictEqual(calls.length, 1, '한 번만');
  at(12000);
  assert.strictEqual(b.update(['a', 'b', 'c', 'd']), false, '5초 안의 다음 카드는 조용히');
  at(20000);
  assert.strictEqual(b.update(['d', 'e']), true, '간격 뒤 새 카드는 다시 울림');
  assert.strictEqual(b.update(['d']), false, '카드가 처리돼 줄어들면 울리지 않음');
  assert.strictEqual(calls.length, 2);
});

test('설정이 꺼져 있으면 울리지 않고, 그동안 온 카드는 켠 뒤에도 새 카드로 치지 않는다', () => {
  let on = false;
  const { b, calls, at } = bell({ enabled: () => on });
  b.update([]);
  at(10000);
  assert.strictEqual(b.update(['a']), false);
  on = true;
  at(20000);
  assert.strictEqual(b.update(['a']), false);
  assert.strictEqual(b.update(['a', 'b']), true);
  assert.strictEqual(calls.length, 1);
});

test('OS별 명령', () => {
  const [cmd, args] = soundCommand('win32', { SystemRoot: "C:\\Win'dows" });
  assert.strictEqual(cmd, 'powershell.exe');
  const script = args[args.length - 1];
  assert.ok(script.includes("C:\\Win''dows\\Media\\Windows Notify System Generic.wav"), '작은따옴표를 PowerShell 문자열로 이스케이프');
  assert.ok(script.includes('PlaySync') && script.includes('SystemSounds'), '파일 재생, 없으면 시스템 소리');
  assert.strictEqual(soundCommand('darwin')[0], 'afplay');
  assert.strictEqual(soundCommand('linux')[0], 'paplay');
});

test('승인 센터: 켤 때 쌓인 카드는 조용히, 새 요청 파일이 오면 울리고, 설정으로 끈다', () => {
  writeReq('old1');
  const fake = install({ workspace: proj });
  fake.settings['wyOps.approvals.sound'] = true;
  try {
    const { ApprovalCenter } = require(path.join(EXT, 'approvalCenter.js'));
    const center = new ApprovalCenter(fake.context);
    let rang = 0;
    center.bell.play = () => rang++;
    center.reload();
    assert.strictEqual(rang, 0, '켤 때 있던 카드');
    writeReq('new1');
    center.reload();
    assert.strictEqual(rang, 1, '새 요청');
    center.bell.last = -Infinity;
    fake.settings['wyOps.approvals.sound'] = false;
    writeReq('new2');
    center.reload();
    assert.strictEqual(rang, 1, '설정을 끄면 조용히');
    center.dispose();
  } finally {
    fake.uninstall();
  }
});
