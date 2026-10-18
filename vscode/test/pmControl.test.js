// pm 제어 줄(0.10.0): 상태(view)·[pm 시작]·[붙기]·[pm 교체] 4단계·실패·[다시 시도]·[멈춤] 확인 창·pm 둘.
//   node vscode/test/pmControl.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PmControl, psArgs, ROTATE_TEXT } = require('../pmControl');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-pmctl-'));
const home = path.join(tmp, 'home');
const folder = path.join(tmp, 'proj');
fs.mkdirSync(path.join(home, '.claude', 'session-data'), { recursive: true });
fs.mkdirSync(folder);

function setup({ remote = false, free = 4 * 1024 ** 3, choice } = {}) {
  let clock = 1_000_000;
  const store = new Map();
  const runs = [];
  const terminals = [];
  const messages = [];
  const executed = [];
  const timers = [];
  const vscode = {
    env: { remoteName: remote ? 'ssh-remote' : undefined },
    Uri: { file: (f) => ({ fsPath: f }) },
    commands: { executeCommand: (...a) => executed.push(a) },
    window: {
      terminals,
      createTerminal: (opts) => {
        const t = { name: opts.name, opts, sent: [], show() {}, sendText(x) { this.sent.push(x); }, dispose() { this.exitStatus = { code: 0 }; this.disposed = true; } };
        terminals.push(t);
        return t;
      },
      showWarningMessage: (...a) => {
        messages.push(a);
        return Promise.resolve(choice === undefined ? undefined : a.slice(2).find((o) => o.title === choice));
      },
    },
  };
  let changes = 0;
  const pm = new PmControl({
    vscode,
    store: { get: (k) => store.get(k), update: (k, v) => store.set(k, v) },
    folder: () => folder,
    ops: () => ({ pmRole: 'AB-pm', root: folder, memory: { blockFreeMB: 500 }, rotation: { contextTokens: 150000 } }),
    run: async (label, file, args, timeout) => {
      runs.push({ label, file, args, timeout });
      return 'ok\n';
    },
    freeMem: () => free,
    logFile: path.join(tmp, `log-${Math.random()}.log`),
    home,
    now: () => clock,
    setTimeout: (f, ms) => timers.push({ f, ms }),
    onChange: () => changes++,
  });
  return { pm, runs, terminals, messages, executed, timers, tick: (ms) => (clock += ms), now: () => clock, changes: () => changes };
}

const bg = (id, sessionId, startedAt, extra = {}) => ({ id, name: 'AB-pm', kind: 'background', pid: 1, sessionId, startedAt, ...extra });
const row = (extra = {}) => ({ name: 'AB-pm', alive: true, view: 'input', contextTokens: 120000, rotate: false, pending: null, ...extra });

(async () => {
  try {
    // PowerShell 출력은 UTF-8로, 경로의 작은따옴표는 두 번
    const a = psArgs("C:\\a'b\\session.ps1", 'start-pm', 'latest');
    assert.ok(a.includes('-Command') && a[a.length - 1].includes("& 'C:\\a''b\\session.ps1' start-pm latest") && a[a.length - 1].startsWith('[Console]::OutputEncoding'), a.join(' '));

    // 한 번도 띄운 적 없음 → 멈춤(아직 시작하지 않음), 원격 창이 아니면 호스트 이름 없음
    let t = setup();
    t.pm.observe([], null);
    let v = t.pm.view();
    assert.deepStrictEqual([v.mode, v.never, v.host], ['stopped', true, null], JSON.stringify(v));

    // 원격 창: 호스트 이름(R-1)
    assert.strictEqual(setup({ remote: true }).pm.view().host, os.hostname());

    // 멈춤: 마지막 pm 대화 기록 시각
    const sid = 'aaaa1111-0000-7000-8000-000000000001';
    const tf = path.join(home, '.claude', 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(tf), { recursive: true });
    fs.writeFileSync(tf, '{}\n');
    t.pm.observe([{ ...bg('aaaa1111', sid, 5), pid: undefined }], { ...row(), sessionId: sid, alive: false });
    v = t.pm.view();
    assert.ok(v.mode === 'stopped' && !v.never && Math.abs(v.stoppedAt - fs.statSync(tf).mtimeMs) < 1, JSON.stringify(v));

    // [pm 시작]: 바로 시작 중, session.ps1 start-pm latest를 긴 제한 시간으로
    const started = t.pm.start();
    assert.strictEqual(t.pm.view().mode, 'starting');
    assert.ok(t.pm.busy(), '시작 중에는 자주 읽기');
    await started;
    assert.ok(t.runs[0].file === 'powershell.exe' && /session\.ps1' start-pm latest$/.test(t.runs[0].args.at(-1)) && t.runs[0].timeout >= 60000, JSON.stringify(t.runs[0]));
    t.pm.observe([bg('bbbb2222', 's2', 10)], row());
    v = t.pm.view();
    assert.strictEqual(v.mode, 'running', '뜨면 실행 중');
    assert.deepStrictEqual([v.tokens, v.limit, v.rotate], [120000, 150000, false]);

    // 60초 안에 안 뜨면 시작 실패 → [다시 시도]는 다시 start-pm
    t = setup();
    await t.pm.start();
    t.tick(61000);
    t.pm.observe([], null);
    assert.strictEqual(t.pm.view().mode, 'startFailed');
    await t.pm.retry();
    assert.strictEqual(t.runs.length, 2, '다시 시도 = 다시 시작');

    // [붙기]: '<pm> 붙기' 터미널(있으면 재사용)
    t = setup();
    t.pm.observe([bg('bbbb2222', 's2', 10)], row());
    t.pm.attach();
    t.pm.attach();
    assert.strictEqual(t.terminals.length, 1, '같은 터미널 재사용');
    assert.ok(t.terminals[0].name === 'AB-pm 붙기' && t.terminals[0].opts.shellArgs.join(' ').endsWith('attach AB-pm'));
    // 붙기마다 pm-control.log에 '붙기: <pmRole> <폴더>' 한 줄
    const attachLog = fs.readFileSync(t.pm.d.logFile, 'utf8').split('\n').filter((l) => / 붙기: /.test(l));
    assert.deepStrictEqual(attachLog.map((l) => l.replace(/^\S+ /, '')), [`붙기: AB-pm ${t.pm.d.folder()}`, `붙기: AB-pm ${t.pm.d.folder()}`], '붙기 기록');

    // [pm 교체]: 열린 터미널이면 문구를 바로 넣는다
    t.pm.rotate();
    assert.deepStrictEqual(t.terminals[0].sent, [ROTATE_TEXT]);
    v = t.pm.view();
    assert.deepStrictEqual([v.mode, v.step, v.steps.map((s) => s.state).join()], ['rotating', 0, 'cur,todo,todo,todo']);
    assert.ok(t.pm.busy());
    t.tick(31000);
    t.pm.observe([bg('bbbb2222', 's2', 10)], row());
    assert.ok(t.pm.view().slow, '30초 넘으면 "하던 일을 마치는 중"');
    // 1단계: 인수인계 파일 → 2단계(새 pm 기다림)
    fs.writeFileSync(path.join(home, '.claude', 'session-data', '2026-10-12-AB-pm-session.tmp'), 'x');
    fs.utimesSync(path.join(home, '.claude', 'session-data', '2026-10-12-AB-pm-session.tmp'), new Date(t.now() + 5000), new Date(t.now() + 5000));
    t.tick(1000);
    t.pm.observe([bg('bbbb2222', 's2', 10)], row());
    v = t.pm.view();
    assert.deepStrictEqual([v.step, v.steps[0].state, v.steps[0].ms], [1, 'done', 32000]);
    // 새 pm이 뜨고 이전 pm이 멈추면 3·4단계 → 터미널을 닫고 새로 붙은 뒤 끝
    t.tick(5000);
    t.pm.observe([bg('bbbb2222', 's2', 10), bg('cccc3333', 's3', 20)], row());
    assert.strictEqual(t.pm.view().step, 2, '새 pm 뜸 → 이전 pm 멈춤 기다림');
    t.tick(5000);
    t.pm.observe([{ ...bg('bbbb2222', 's2', 10), pid: undefined }, bg('cccc3333', 's3', 20)], row({ contextTokens: 30000 }));
    v = t.pm.view();
    assert.ok(t.terminals[0].disposed && t.terminals.length === 2, '이전 붙기 터미널 닫고 새로 붙음');
    assert.ok(v.mode === 'running' && v.doneAt && !t.pm.busy(), JSON.stringify(v));

    // 새 터미널이면 attach가 뜬 뒤에 넣는다(5초 뒤)
    t = setup();
    t.pm.observe([bg('bbbb2222', 's2', 10)], row());
    t.pm.rotate();
    assert.ok(t.terminals[0].sent.length === 0 && t.timers[0].ms === 5000);
    t.timers[0].f();
    assert.deepStrictEqual(t.terminals[0].sent, [ROTATE_TEXT]);

    // 2단계에서 60초 넘으면 실패(이전 pm 상태를 함께) → [다시 시도]는 start-pm latest -Force
    t.tick(1000);
    t.pm.observe([bg('bbbb2222', 's2', 10)], row()); // 저장 근거 없음: 그대로
    fs.utimesSync(path.join(home, '.claude', 'session-data', '2026-10-12-AB-pm-session.tmp'), new Date(t.now() + 1000), new Date(t.now() + 1000));
    t.pm.observe([bg('bbbb2222', 's2', 10)], row());
    t.tick(61000);
    t.pm.observe([bg('bbbb2222', 's2', 10)], row());
    v = t.pm.view();
    assert.ok(v.mode === 'rotateFailed' && v.steps[1].state === 'fail' && /60초.*이전 pm은 그대로/.test(v.error), JSON.stringify(v));
    assert.ok(!t.pm.busy(), '실패하면 자주 읽지 않음');
    await t.pm.retry();
    assert.ok(/start-pm latest -Force$/.test(t.runs.at(-1).args.at(-1)), '실패한 단계부터');
    assert.strictEqual(t.pm.view().mode, 'rotating');
    t.pm.close();
    assert.strictEqual(t.pm.view().mode, 'running', '[닫기]');

    // 메모리가 막는 선 아래면 교체하지 않는다
    t = setup({ free: 400 * 1024 ** 2 });
    t.pm.observe([bg('bbbb2222', 's2', 10)], row());
    t.pm.rotate();
    v = t.pm.view();
    assert.ok(v.mode === 'memory' && /여유 0\.4GB/.test(v.error) && t.terminals.length === 0, JSON.stringify(v));

    // pm 둘
    t = setup();
    t.pm.observe([bg('bbbb2222', 's2', 10), bg('cccc3333', 's3', 20)], row());
    assert.deepStrictEqual([t.pm.view().mode, t.pm.view().count], ['two', 2]);
    await t.pm.stopOld();
    assert.ok(/claude stop bbbb2222$/.test(t.runs.at(-1).args.at(-1)), '오래된 pm을 멈춤');

    // [멈춤]: 확인 창(작업 중이면 끊긴다는 문장), 취소가 먼저·닫기 버튼 → Esc·Enter는 아무것도 안 함
    t = setup();
    t.pm.observe([bg('bbbb2222', 's2', 10)], row({ view: 'working' }));
    await t.pm.stop();
    const [title, opts, cancel, go] = t.messages[0];
    assert.ok(title === 'AB-pm을 멈출까요?' && opts.modal && /지금 작업 중입니다/.test(opts.detail) && cancel.isCloseAffordance && cancel.title === '취소' && go.title === '멈춤');
    assert.strictEqual(t.runs.length, 0, '취소면 멈추지 않음');
    t = setup({ choice: '멈춤' });
    t.pm.observe([bg('bbbb2222', 's2', 10)], row());
    await t.pm.stop();
    assert.ok(!/지금 작업 중/.test(t.messages[0][1].detail), '입력 대기면 첫 문장 없음');
    assert.ok(/session\.ps1' stop AB-pm$/.test(t.runs[0].args.at(-1)));

    // [기록 보기]: 기록 파일을 편집기로
    t.pm.openLog();
    assert.ok(t.executed[0][0] === 'vscode.open' && fs.existsSync(t.executed[0][1].fsPath));

    console.log('pmControl 검사 통과');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
