// 세션 현황 뷰(B1-1~3): 메모리 경고 선 전달, 열기(attach) 터미널, 커밋 세션 경고, "세션 현황에서 보기" 재전달.
//   node tools/wy-ops/vscode/test/sessionsView.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.WY_APPROVALS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-sess-'));
const { install, EXT, REPO } = require('./fakeVscode');

const fake = install({ workspace: REPO });
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  try {
    const memento = new Map();
    fake.context.globalState = { get: (k) => memento.get(k), update: async (k, v) => memento.set(k, v) };
    const provider = require(path.join(EXT, 'sessionsView.js')).register(fake.context);
    const view = fake.resolveView('wyOps.sessions');
    view.visible = false; // 폴링(claude agents 실행)은 하지 않는다

    // "세션 현황에서 보기"가 webview 준비 전에 와도 ready 뒤 다시 보낸다
    await fake.commands['wyOps.revealSession']('abcd1234-0000-7000-8000-000000000000');
    assert.ok(fake.executed.some((e) => e[0] === 'wyOps.sessions.focus'), '뷰 열기');
    view.posts.length = 0;
    view.send({ type: 'ready' });
    assert.ok(view.posts.some((m) => m.type === 'reveal' && m.sessionId.startsWith('abcd1234')), 'ready 뒤 reveal 재전달');

    // 메모리 경고 선: 저장소 wy-ops.json의 memory 값(D-86)
    const limits = view.posts.find((m) => m.type === 'limits');
    const ops = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'wy-ops.json'), 'utf8'));
    assert.deepStrictEqual(limits.data, { warnFreeMB: ops.memory.warnFreeMB, blockFreeMB: ops.memory.blockFreeMB }, '메모리 경고 선');

    // 열기: 새 터미널에서 claude.cmd attach
    view.send({ type: 'open', id: '60d4ef69', name: 'WY-backend1' });
    await flush();
    assert.strictEqual(fake.terminals.length, 1, '터미널 하나');
    assert.deepStrictEqual(fake.terminals[0].sent, ['claude.cmd attach 60d4ef69']);
    assert.ok(fake.terminals[0].shown, '터미널 보임');

    // 이상한 id는 명령으로 보내지 않는다
    view.send({ type: 'open', id: '1 & del x', name: 'WY-qa' });
    await flush();
    assert.strictEqual(fake.terminals.length, 1, '잘못된 id 무시');

    // 커밋 세션: 경고를 먼저 띄우고, 취소하면 열지 않는다(OPS-06 4)
    fake.nextChoice = undefined;
    view.send({ type: 'open', id: '985b4168', name: ops.commitRole });
    await flush();
    const warn = fake.messages.find((m) => m[0] === 'warning');
    assert.ok(warn && /세션 교체/.test(warn[1]) && warn[2].modal, '커밋 세션 경고(모달)');
    assert.strictEqual(fake.terminals.length, 1, '취소하면 열지 않음');
    fake.nextChoice = '열기';
    view.send({ type: 'open', id: '985b4168', name: ops.commitRole });
    await flush();
    assert.deepStrictEqual(fake.terminals[1].sent, ['claude.cmd attach 985b4168'], '경고 뒤 열기');

    // 꺼진 뒤 메시지 옴: 확인함을 누르면 그 세션 경고를 숨기고 globalState에 기억, 그 뒤 새로 막히면 다시 띄운다
    const off = (msgs) => ({ name: 'WY-search', sessionId: 'sid-s', view: 'off', offReason: 'done', offMessages: msgs });
    const m1 = { at: '2026-10-07T10:00:00Z', from: 'WY-pm', summary: '' };
    const m2 = { at: '2026-10-07T11:00:00Z', from: '', summary: '' };
    const quiet = { name: 'WY-frontend', sessionId: 'sid-f', view: 'off', offReason: 'done', offMessages: [] };
    let rows = provider.applyAcks([off([m1]), quiet]);
    assert.deepStrictEqual(rows[0].offWarning, { count: 1, lastAt: m1.at, from: ['WY-pm'], summary: '' }, '경고');
    assert.strictEqual(rows[1].offWarning, null, '정상으로 끝난 세션은 경고 없음');
    provider.cache.sessions = { type: 'sessions', data: rows, at: Date.now() };
    view.posts.length = 0;
    view.send({ type: 'ackOff', sessionId: 'sid-s' });
    assert.deepStrictEqual(memento.get('wyOps.offMessageAck'), { 'sid-s': m1.at }, 'globalState에 기억');
    const sent = view.posts.find((m) => m.type === 'sessions');
    assert.strictEqual(sent && sent.data[0].offWarning, null, '확인함 뒤 바로 숨김');
    assert.strictEqual(provider.applyAcks([off([m1])])[0].offWarning, null, '다시 읽어도 숨김');
    assert.strictEqual(provider.applyAcks([off([m1, m2])])[0].offWarning.count, 1, '확인 뒤 새로 막힌 것만 다시 경고');

    // pm 줄(0.10.0): ready에 pm 상태를 보내고, 버튼 메시지는 PmControl로(뒤이은 세션 읽기는 막아 둔다)
    view.posts.length = 0;
    view.send({ type: 'ready' });
    const pmMsg = view.posts.find((m) => m.type === 'pm');
    assert.ok(pmMsg && pmMsg.data.name === ops.pmRole && pmMsg.data.host === null, `pm 줄 상태
${JSON.stringify(pmMsg)}`);
    provider.update = async () => {};
    const before = fake.terminals.length;
    view.send({ type: 'pmAttach' });
    await flush();
    assert.ok(fake.terminals.length === before + 1 && fake.terminals.at(-1).opts.name === `${ops.pmRole} 붙기`, '[붙기] → pm 붙기 터미널');

    // 끊긴 SSH 묶음(0.11.0): 줄 값은 cleaner.read(), [정리]는 orphansStop → 결과 한 줄 → 줄 다시 읽기, 자동 정리는 읽은 값으로
    //   판정·끄기 자체는 orphanCleaner.test.js·test/sshOrphans.test.js
    const { Provider } = require(path.join(EXT, 'sessionsView.js'));
    const log = [];
    let seen = { count: 3, mb: 900, admin: true };
    const cleaner = {
      read: async () => (log.push('read'), seen),
      stop: async (kind) => (log.push('stop:' + kind), { kind, at: 1, count: 3, mb: 900, failed: 0 }),
      maybeAuto: (d) => (log.push('auto?'), d.admin && d.count ? cleaner.stop('auto') : null),
    };
    const p2 = new Provider(fake.context.extensionUri, fake.context.globalState, null, cleaner);
    const posts2 = [];
    p2.view = { webview: { postMessage: (m) => posts2.push(m) } };
    const wait = async () => { for (let k = 0; k < 20; k++) await flush(); };
    // 읽은 값에 후보가 있고 관리자면 자동 정리 → 결과 → 다시 읽음(다시 읽은 값으로는 또 정리하지 않게 seen을 0으로)
    cleaner.stop = async (kind) => { log.push('stop:' + kind); seen = { count: 0, mb: 0, admin: true }; return { kind, at: 1, count: 3, mb: 900, failed: 0 }; };
    await p2.update('orphans');
    await wait();
    assert.deepStrictEqual(log, ['read', 'auto?', 'stop:auto', 'read', 'auto?'], log.join(','));
    assert.deepStrictEqual(posts2.map((m) => m.type), ['orphans', 'orphansBusy', 'orphansResult', 'orphans']);
    assert.deepStrictEqual(posts2[0].data, { count: 3, mb: 900, admin: true });
    assert.strictEqual(posts2[2].data.kind, 'auto');
    assert.strictEqual(p2.cache.orphansResult.data.count, 3, '다시 열어도 결과 한 줄을 보이게 cache');
    // [정리] 버튼(webview 메시지)
    log.length = 0;
    posts2.length = 0;
    const view2 = { visible: false, posts: posts2, webview: { postMessage: (m) => posts2.push(m), options: {}, asWebviewUri: (u) => u, cspSource: 'x', onDidReceiveMessage(h) { this.handler = h; } }, onDidChangeVisibility() {}, onDidDispose() {} };
    p2.resolveWebviewView(view2);
    await wait();
    // 자동 정리용 판정: 안 보이고(visible false) 접혀 있어도 뷰가 뜨면 바로 한 번, 그 뒤 10분마다
    assert.deepStrictEqual(log, ['read', 'auto?'], '뷰가 뜨면 표시와 상관없이 판정');
    assert.ok(p2.autoTimer, '10분 타이머');
    log.length = 0;
    view2.webview.handler({ type: 'orphansStop' });
    await wait();
    assert.ok(log[0] === 'stop:manual' && log.includes('read'), log.join(','));
    assert.ok(posts2.some((m) => m.type === 'orphansResult' && m.data.kind === 'manual'));
    // host 아님·스크립트 없음이면 read가 null → 자동 정리를 묻지도 않는다
    log.length = 0;
    cleaner.read = async () => (log.push('read'), null);
    await p2.update('orphans');
    await wait();
    assert.deepStrictEqual(log, ['read']);
    p2.stopAutoClean();
    assert.strictEqual(p2.autoTimer, null);

    console.log('sessionsView 검사 통과');
  } finally {
    fake.uninstall();
    fs.rmSync(process.env.WY_APPROVALS_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
