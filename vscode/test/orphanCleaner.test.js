// 끊긴 SSH 묶음 정리(0.11.0, vscode/orphanCleaner.js): SSH 원격 호스트 판별, 줄 값, [정리], 자동 정리 간격.
// 스크립트(ssh-orphans.ps1)는 부르지 않고 fixtures/orphans의 출력으로 대신한다. 실제 프로세스는 끄지 않는다.
//   node vscode/test/orphanCleaner.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OrphanCleaner, isSshHost, AUTO_GAP_MS } = require('../orphanCleaner');

const FIX = path.join(__dirname, 'fixtures', 'orphans');
const fx = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-orphan-clean-'));
const script = path.join(dir, 'ssh-orphans.ps1');

// 가짜 run: reg는 regOut(없으면 종료 코드 1처럼 throw), powershell은 -Stop 여부로 고른 출력. 부른 기록을 남긴다
function fakeRun({ reg = 'reg-host.txt', judge = 'judge-admin.json', stop = 'stop-admin.json' } = {}) {
  const calls = [];
  const run = async (label, file, args, timeout) => {
    calls.push({ label, file, args, timeout });
    if (file === 'reg.exe') {
      if (!reg) throw new Error('reg 실패(종료 코드 1)');
      return fx(reg);
    }
    const out = args.includes('-Stop') ? stop : judge;
    if (out instanceof Error) throw out;
    return fx(out);
  };
  run.calls = calls;
  run.ps = () => calls.filter((c) => c.file === 'powershell.exe');
  return run;
}

(async () => {
  try {
    // SSH 원격 호스트 판별: install.ps1 host가 바꾸는 DefaultShell(Windows PowerShell)
    assert.strictEqual(await isSshHost(fakeRun()), true, 'host 한 PC');
    assert.strictEqual(await isSshHost(fakeRun({ reg: 'reg-cmd-shell.txt' })), false, 'OpenSSH는 있지만 host 안 함(cmd 셸)');
    assert.strictEqual(await isSshHost(fakeRun({ reg: null })), false, '키 없음');
    const r0 = fakeRun();
    await isSshHost(r0);
    assert.deepStrictEqual(r0.calls[0].args, ['query', 'HKLM\\SOFTWARE\\OpenSSH', '/v', 'DefaultShell']);

    // 스크립트 없음(옛 설치본): 아무것도 부르지 않고 null
    let run = fakeRun();
    let c = new OrphanCleaner({ file: script, run });
    assert.strictEqual(await c.read(), null);
    assert.strictEqual(run.calls.length, 0, '스크립트 없으면 reg도 부르지 않음');
    fs.writeFileSync(script, '');

    // host 안 한 설치본: 줄·[정리]·자동 정리 모두 없음(스크립트를 부르지 않는다)
    run = fakeRun({ reg: null });
    c = new OrphanCleaner({ file: script, run });
    assert.strictEqual(await c.read(), null);
    assert.strictEqual(await c.maybeAuto({ count: 3, mb: 900, admin: true }).then((x) => x.error), 'SSH 원격 호스트가 아닙니다');
    assert.strictEqual(run.ps().length, 0, 'host 아니면 PowerShell 판정·정리를 부르지 않음');

    // host: 줄 값(BOM 붙은 출력도 읽음), 판별은 창마다 한 번
    run = fakeRun();
    c = new OrphanCleaner({ file: script, run });
    assert.deepStrictEqual(await c.read(), { count: 10, mb: 3072, admin: true });
    await c.read();
    assert.strictEqual(run.calls.filter((x) => x.file === 'reg.exe').length, 1, 'reg는 한 번만');
    const judge = run.ps()[0];
    assert.ok(judge.args.includes('-Json') && !judge.args.includes('-Stop') && judge.args.includes(script) && judge.timeout >= 10000, JSON.stringify(judge));

    // 일반 권한 창(호스트에서 직접 연 VS Code): admin false → 자동 정리 안 함
    run = fakeRun({ judge: 'judge-user.json' });
    c = new OrphanCleaner({ file: script, run });
    const user = await c.read();
    assert.deepStrictEqual(user, { count: 2, mb: 624, admin: false });
    assert.strictEqual(c.maybeAuto(user), null, '관리자 아니면 자동 정리 시도 안 함');
    assert.ok(!run.ps().some((x) => x.args.includes('-Stop')));

    // 실패·이상한 출력은 줄을 숨김(null)
    run = fakeRun({ judge: new Error('ssh-orphans 응답 없음(30초)') });
    assert.strictEqual(await new OrphanCleaner({ file: script, run }).read(), null);
    run = fakeRun({ judge: 'reg-host.txt' });
    assert.strictEqual(await new OrphanCleaner({ file: script, run }).read(), null);

    // [정리]: -Stop 결과의 stoppedChains(다시 판정해도 후보였던 묶음)·끄지 못한 프로세스 수
    let t = Date.parse('2026-10-12T15:12:00');
    run = fakeRun();
    c = new OrphanCleaner({ file: script, run, now: () => t });
    const manual = await c.stop('manual');
    assert.deepStrictEqual(manual, { kind: 'manual', at: t, count: 9, mb: 2860, failed: 1 });
    assert.ok(run.ps().at(-1).args.includes('-Stop') && run.ps().at(-1).args.includes('-Json'));
    // 누르는 동안 또 누르면 같은 작업을 기다린다(두 번 돌리지 않음)
    const n = run.ps().length;
    const [a, b] = await Promise.all([c.stop('manual'), c.stop('manual')]);
    assert.strictEqual(a, b);
    assert.strictEqual(run.ps().length, n + 1);
    // 스크립트가 관리자 아님을 알리면(권한이 바뀐 경우) 오류 한 줄
    run = fakeRun({ stop: 'judge-user.json' });
    assert.strictEqual((await new OrphanCleaner({ file: script, run }).stop('manual')).error, '관리자 권한이 필요합니다');
    run = fakeRun({ stop: new Error('ssh-orphans 실패(종료 코드 1)') });
    assert.strictEqual((await new OrphanCleaner({ file: script, run }).stop('manual')).error, 'ssh-orphans 실패(종료 코드 1)');

    // 자동 정리: 관리자·후보 있음일 때, AUTO_GAP_MS(10분)에 한 번까지
    run = fakeRun();
    c = new OrphanCleaner({ file: script, run, now: () => t });
    const seen = { count: 10, mb: 3072, admin: true };
    assert.strictEqual(c.maybeAuto({ ...seen, count: 0 }), null, '후보 없으면 안 함');
    const auto = await c.maybeAuto(seen);
    assert.strictEqual(auto.kind, 'auto');
    assert.strictEqual(auto.count, 9);
    t += 60 * 1000;
    assert.strictEqual(c.maybeAuto(seen), null, '1분 뒤 다시 보아도 안 함');
    t += AUTO_GAP_MS;
    assert.ok(c.maybeAuto(seen), '10분 지나면 다시');
    assert.strictEqual(AUTO_GAP_MS, 10 * 60 * 1000);

    console.log('orphanCleaner 검사 통과');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
