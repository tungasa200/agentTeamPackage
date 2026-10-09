// 결정 도착 깨우기(hooks/wy-decision-wake.js): 이 세션 앞 결정만, 한 번만, 세션당 대기 1개, 깨운 턴 사이에 온 결정도 놓치지 않음.
//   node vscode/test/decisionWake.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const wake = require('../hooks/wy-decision-wake');

const SID = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
const agents = (name = 'XX-a') => async () => [{ sessionId: SID, name }, { sessionId: OTHER, name: 'XX-b' }];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-wake-'));
  fs.mkdirSync(path.join(root, 'decisions'), { recursive: true });
  const log = path.join(root, 'decisions.log');
  fs.writeFileSync(log, '');
  const add = (line, decision) => {
    if (decision) fs.writeFileSync(path.join(root, 'decisions', `${line.id}.json`), JSON.stringify({ id: line.id, ...decision }));
    fs.appendFileSync(log, JSON.stringify(line) + '\n');
  };
  return { root, log, add };
}

// 조건이 맞을 때까지 기다리는 wait(): 시험이 줄을 덧붙이는 동안 짧은 간격으로 돈다. 끝나지 않으면 shouldStop으로 멈춘다
function run(root, opts = {}) {
  let stop = false;
  const p = wake.wait({ session_id: SID }, { root, listAgents: agents(opts.name), pollMs: 10, parentPid: 0, shouldStop: () => stop, ...opts.extra });
  return { p, stop: () => (stop = true) };
}
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. 처음 뜬 대기는 로그 끝에서 시작: 지난 결정은 알리지 않고, 새로 온 이 세션 앞 결정만 알린다(선택값 요약)
  {
    const { root, add } = setup();
    add({ id: 'old-1', kind: 'commit', session: 'XX-a', decision: 'approved' });
    const w = run(root);
    await tick();
    add({ id: 'c-2', kind: 'choice', session: 'XX-b', decision: 'answered' }); // 다른 세션
    add({ id: 'c-3', kind: 'choice', session: 'XX-a', decision: 'answered' }, { answers: [{ selected: ['A. 훅 asyncRewake'], other: null }], note: '' });
    const text = await w.p;
    assert.ok(text, '깨움 문구');
    assert.match(text, /결정 1건/);
    assert.match(text, /- c-3 · choice · answered · A\. 훅 asyncRewake/);
    assert.ok(!/old-1|c-2/.test(text), '지난 결정·다른 세션 결정은 빠짐:\n' + text);
    assert.ok(!fs.existsSync(wake.lockFile(root, SID)), '끝나면 잠금을 푼다');

    // 2. 같은 결정을 다시 알리지 않는다. 깨운 턴 동안(대기 없음) 온 결정은 다음 대기가 바로 알린다
    add({ id: 't-4', kind: 'todo', session: 'XX-a', decision: 'done' }, { note: '실행함 '.repeat(30) });
    const text2 = await run(root).p;
    assert.match(text2, /- t-4 · todo · done · 실행함/);
    assert.ok(!/c-3/.test(text2), '이미 알린 결정은 다시 없음');
    assert.ok(text2.split('\n')[1].length <= 120, '메모는 앞부분만');
    const w3 = run(root);
    await tick(80);
    w3.stop();
    assert.strictEqual(await w3.p, null, '새 결정이 없으면 깨우지 않음');
  }

  // 3. 세션당 대기 1개: 살아 있는 대기의 잠금이 있으면 바로 끝나고, 죽은 pid의 잠금은 넘겨받는다
  {
    const { root, add } = setup();
    const lock = wake.lockFile(root, SID);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, String(process.ppid)); // 살아 있는 다른 프로세스
    assert.strictEqual(await run(root).p, null, '살아 있는 대기가 있으면 그냥 끝남');
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.ppid), '남의 잠금은 그대로');
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    fs.writeFileSync(lock, dead);
    const w = run(root);
    await tick();
    assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid), '죽은 대기의 잠금을 넘겨받음');
    add({ id: 'p-1', kind: 'push', session: 'XX-a', decision: 'rejected' }, { reason: '푸시는 내일' });
    assert.match(await w.p, /- p-1 · push · rejected · 푸시는 내일/);
  }

  // 4. 멈춤 알림은 relatedSessions(pm)를 깨운다. 쓰는 중인 줄(줄바꿈 전)은 아직 읽지 않는다. 이름을 모르면 줄을 넘기지 않는다
  {
    const { root, log, add } = setup();
    const w = run(root, { name: 'XX-pm' });
    await tick();
    add({ id: 'stuck-1', kind: 'stuck', session: 'XX-a', relatedSessions: ['XX-pm'], decision: 'stuck', notice: 'XX-a 세션이 도구 한 번에 12분째 묶여 있습니다.' });
    assert.match(await w.p, /- stuck-1 · stuck · XX-a 세션이 도구 한 번에 12분째/);

    fs.appendFileSync(log, '{"id":"half","kind":"commit","session":"XX-a"');
    const r = wake.readNewLines(log, fs.statSync(log).size - 10);
    assert.deepStrictEqual(r.lines, [], '줄바꿈 전 줄은 읽지 않음');
    fs.appendFileSync(log, ',"decision":"approved"}\n');

    let calls = 0;
    const nobody = async () => (++calls, []);
    const w2 = run(root, { extra: { listAgents: nobody } });
    await tick();
    add({ id: 'n-1', kind: 'commit', session: 'XX-a', decision: 'approved' });
    await tick(80);
    w2.stop();
    assert.strictEqual(await w2.p, null);
    assert.ok(calls >= 1, '이름 찾기를 시도함');
    assert.match(await run(root).p, /- n-1 · commit · approved/, '이름을 몰라 넘기지 않은 줄은 다음 대기가 알림');
  }

  // 5. 부모 세션(CLAUDE_PID)이 없으면 끝난다
  {
    const { root } = setup();
    const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
    assert.strictEqual(await wake.wait({ session_id: SID }, { root, listAgents: agents(), pollMs: 10, parentPid: dead }), null);
  }

  // 6. 훅 실행: 세션 id가 이상하면 아무것도 쓰지 않고 종료 코드 0
  {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'wy-decision-wake.js')], { input: '{"session_id":"../x"}', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, '');
  }

  console.log('decisionWake 검사 통과');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
