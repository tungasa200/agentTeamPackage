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

    console.log('sessionsView 검사 통과');
  } finally {
    fake.uninstall();
    fs.rmSync(process.env.WY_APPROVALS_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
