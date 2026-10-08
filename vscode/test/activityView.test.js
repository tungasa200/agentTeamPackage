// 활동 탭(activityView) 검사: 가짜 vscode로 탭을 열고, 합성 대화 기록·세션 상태·승인 카드로 만든 상태를 확인한다.
//   node tools/wy-ops/vscode/test/activityView.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.WY_APPROVALS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-act-ap-'));
const { install, EXT, REPO } = require('./fakeVscode');
const made = []; // setup()이 만든 임시 대화 기록 폴더

const now = Date.now();
const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const line = (o) => JSON.stringify(o);
const recv = (minAgo, from, id, body) => line({ type: 'user', isMeta: true, timestamp: at(minAgo), origin: { kind: 'peer', name: from, msg_id: id, body }, message: { role: 'user', content: '…' } });

function setup() {
  const fake = install({ workspace: REPO });
  const activity = require(path.join(EXT, 'activityView.js'));
  const { ActivityReader } = require(path.join(EXT, 'sessionActivity.js'));
  const view = activity.register(fake.context);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-act-tr-'));
  made.push(dir);
  view.reader = new ActivityReader({ dir }); // 실제 대화 기록 대신 합성 기록
  return { fake, view, dir, activity };
}

// 순수 함수만 쓰는 검사도 activityView가 require('vscode')를 하므로 가짜를 깔고 불러온다
function pure() {
  const fake = install({ workspace: null });
  const mod = require(path.join(EXT, 'activityView.js'));
  fake.uninstall();
  return mod;
}

test('dialog open은 입력 대기, 권한 확인은 권한 대기로 나눈다', () => {
  const { classify } = pure();
  assert.strictEqual(classify({ state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' }), 'permission');
  assert.strictEqual(classify({ state: 'blocked', status: 'waiting', waitingFor: 'dialog open' }), 'input');
  assert.strictEqual(classify({ state: 'done', status: 'idle' }), 'input');
  assert.strictEqual(classify({ state: 'done' }), 'off', '스스로 끝남은 꺼짐');
  assert.strictEqual(classify({ state: 'stopped' }), 'off', '멈춤도 꺼짐');
  assert.strictEqual(classify({ state: 'working', status: 'busy' }), 'working');
  assert.strictEqual(classify({ status: 'busy' }), 'working');
});

test('이름마다 살아 있는 것, 그다음 최신 세션 하나만 남긴다', () => {
  const { latestByName } = pure();
  const m = latestByName([
    { name: 'WY-qa', view: 'working', startedAt: 1 },
    { name: 'WY-qa', view: 'off', startedAt: 9 },
    { name: 'WY-pm', view: 'input', startedAt: 1 },
    { name: 'WY-pm', view: 'input', startedAt: 5 },
  ]);
  assert.strictEqual(m.get('WY-qa').startedAt, 1);
  assert.strictEqual(m.get('WY-pm').startedAt, 5);
});

test('탭을 열면 메시지·묶음·세션 상태·카드 연결을 보낸다', async () => {
  const { fake, view, dir } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'pm.jsonl'), [line({ type: 'agent-name', agentName: 'WY-pm' }), recv(30, 'WY-qa', 'm1', '[결함] P1-09-09 입력 손실\n재현 3단계')].join('\n') + '\n');
    const work = (minAgo) => line({ type: 'assistant', timestamp: at(minAgo), message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } });
    fs.writeFileSync(path.join(dir, 'f2.jsonl'), [line({ type: 'agent-name', agentName: 'WY-frontend2' }), recv(20, 'WY-pm', 'm2', 'WY-pm 지시: P1-09-09 결함 수정'), work(19), work(18)].join('\n') + '\n');
    view.status = { list: [{ name: 'WY-frontend2', sessionId: 'f2-sid', view: 'permission', pending: { command: 'npx vitest' }, startedAt: 1 }, { name: 'WY-qa', view: 'working', startedAt: 1 }], error: null, at: now };

    // 이 세션들에 걸린 승인 카드(읽기만 한다)
    const store = require(path.join(EXT, 'approvalStore.js'));
    const root = store.rootFor(REPO);
    store.ensureDirs(root);
    fs.writeFileSync(path.join(root, 'requests', 'card-1.json'), JSON.stringify({ kind: 'commit', session: 'WY-frontend2', createdAt: at(10), title: 'P1-09-09 커밋', command: 'git commit', what: '커밋', why: '시험', onClick: '실행' }));

    fake.commands['wyActivity.open']();
    const panel = fake.panels.find((p) => p.type === 'wyActivity');
    assert.ok(!/{{\w+}}/.test(panel.webview.html), 'HTML 자리표시자 모두 채움');
    assert.ok(!/style="/.test(panel.webview.html), '인라인 style 없음(CSP)');
    panel.send({ type: 'ready' });
    const st = panel.posts.filter((m) => m.type === 'state').pop().state;

    assert.deepStrictEqual(st.feed, ['m2', 'm1'], '피드는 최신순');
    assert.strictEqual(st.transcriptsMissing, null, '대화 기록 폴더 있음');
    assert.strictEqual(st.messages.m1.title, '[결함] P1-09-09 입력 손실');
    assert.strictEqual(st.messages.m1.body, '[결함] P1-09-09 입력 손실\n재현 3단계', '원문 전체');
    const b = st.bundles.find((x) => x.taskId === 'P1-09-09');
    assert.deepStrictEqual(b.steps.map((s) => s.stage), ['bug', 'order']);
    assert.strictEqual(b.state, 'perm', '참여 세션이 권한 대기면 묶음도 권한 대기');
    assert.strictEqual(b.card && b.card.id, 'card-1', '묶음 세션의 대기 카드');

    // 시간 보기 레인: 일한 구간이 30초 단위로 맞춰지고, 읽기 시작 시각이 있다
    const lane = st.lanes.find((l) => l.name === 'WY-frontend2');
    assert.strictEqual(lane.bands.length, 1);
    assert.ok(lane.bands[0][0] % 30000 === 0 && lane.bands[0][1] % 30000 === 0 && lane.bands[0][1] > lane.bands[0][0]);
    assert.ok(lane.from <= Date.parse(at(19)));

    const f2 = st.sessions.find((s) => s.name === 'WY-frontend2');
    assert.deepStrictEqual([f2.view, f2.pending.command], ['permission', 'npx vitest']);
    assert.strictEqual(st.sessions.find((s) => s.name === 'WY-design').view, 'off', '목록에 없는 역할은 꺼짐');

    // 같은 상태면 다시 보내지 않고, 새 메시지가 붙으면 보낸다
    const n = panel.posts.length;
    view.refresh();
    assert.strictEqual(panel.posts.length, n);
    fs.appendFileSync(path.join(dir, 'pm.jsonl'), recv(0, 'WY-frontend2', 'm3', 'P1-09-09 커밋 요청') + '\n');
    view.refresh();
    assert.strictEqual(panel.posts.length, n + 1);

    // 카드 열기·세션 현황에서 보기는 명령으로 넘긴다
    panel.send({ type: 'openCard', id: 'card-1' });
    panel.send({ type: 'revealSession', sessionId: 'f2-sid' });
    assert.deepStrictEqual(fake.executed.slice(-2), [['wyApprovals.open', { id: 'card-1' }], ['wyOps.revealSession', 'f2-sid']]);
  } finally {
    fake.uninstall();
  }
});

test('완료 묶음은 진행 중 뒤로 가고, 다시 움직이면 진행 중으로 돌아온다', () => {
  const { fake, view, dir } = setup();
  try {
    view.status = { list: [], error: null, at: now };
    const file = path.join(dir, 'qa.jsonl');
    fs.writeFileSync(file, [line({ type: 'agent-name', agentName: 'WY-qa' }),
      recv(50, 'WY-pm', 'a1', 'WY-pm 지시: P1-11 재검증'), recv(40, 'WY-pm', 'a2', '[완료] P1-11 재검증 통과'),
      recv(30, 'WY-design', 'b1', 'P1-12 목업 확인 부탁')].join('\n') + '\n');
    fake.commands['wyActivity.open']();
    const panel = fake.panels.find((p) => p.type === 'wyActivity');
    panel.send({ type: 'ready' });
    let st = panel.posts.filter((m) => m.type === 'state').pop().state;
    assert.deepStrictEqual(st.bundles.map((b) => [b.taskId, b.done]), [['P1-12', false], ['P1-11', true]], '진행 중이 먼저, 완료는 뒤');

    // 완료된 P1-11에 새 결함이 붙으면 진행 중으로, 최근에 움직였으니 맨 위로
    fs.appendFileSync(file, recv(0, 'WY-pm', 'a3', '[결함] P1-11 재발') + '\n');
    view.refresh();
    st = panel.posts.filter((m) => m.type === 'state').pop().state;
    assert.deepStrictEqual(st.bundles.map((b) => [b.taskId, b.done]), [['P1-11', false], ['P1-12', false]]);
  } finally {
    fake.uninstall();
  }
});

test('2시간 넘게 조용한 진행 중 묶음은 휴면, 새 메시지가 오면 깨어나고, 권한 대기·대기 카드는 휴면으로 보내지 않는다', () => {
  const { fake, view, dir } = setup();
  try {
    const file = path.join(dir, 'pm.jsonl');
    fs.writeFileSync(file, [line({ type: 'agent-name', agentName: 'WY-pm' }),
      recv(10, 'WY-qa', 'q1', 'P2-01 확인 부탁'), // 그냥 조용해진 묶음 → 휴면
      recv(10, 'WY-backend1', 'w1', 'P2-02 실행 전 권한 대기'), // 참여 세션이 권한 대기 → 진행 중 유지
      recv(10, 'WY-browser', 'c1', 'P2-03 콘솔 작업 카드 올림'), // 대기 카드 걸림 → 진행 중 유지
      recv(10, 'WY-design', 'd1', '[완료] P2-04 목업 끝')].join('\n') + '\n'); // 완료는 휴면이 아니라 완료
    view.status = { list: [{ name: 'WY-backend1', view: 'permission', startedAt: 1 }], error: null, at: now };
    const store = require(path.join(EXT, 'approvalStore.js'));
    const root = store.rootFor(REPO);
    store.ensureDirs(root);
    fs.writeFileSync(path.join(root, 'requests', 'card-browser.json'), JSON.stringify({ kind: 'commit', session: 'WY-browser', createdAt: at(5), title: '콘솔 작업', command: 'x', what: 'x', why: 'x', onClick: 'x' }));

    fake.commands['wyActivity.open']();
    const panel = fake.panels.find((p) => p.type === 'wyActivity');
    const latest = () => panel.posts.filter((m) => m.type === 'state').pop().state;
    const kinds = (st) => Object.fromEntries(st.bundles.map((b) => [b.taskId, b.done ? 'done' : b.dormant ? 'dormant' : 'running']));

    // 10분 전 메시지: 아직 아무것도 휴면 아님
    panel.send({ type: 'ready' });
    assert.deepStrictEqual(kinds(latest()), { 'P2-01': 'running', 'P2-02': 'running', 'P2-03': 'running', 'P2-04': 'done' });

    // 3시간 뒤: 조용한 묶음만 휴면, 권한 대기·대기 카드 묶음은 진행 중, 완료는 완료
    view.clock = () => now + 3 * 3600000;
    view.refresh();
    let st = latest();
    assert.deepStrictEqual(kinds(st), { 'P2-01': 'dormant', 'P2-02': 'running', 'P2-03': 'running', 'P2-04': 'done' });
    const order = st.bundles.map((b) => b.taskId);
    assert.ok(order.indexOf('P2-01') > order.indexOf('P2-02') && order.indexOf('P2-01') < order.indexOf('P2-04'), '휴면은 진행 중과 완료 사이');

    // 휴면 묶음에 새 메시지가 오면 다시 진행 중
    fs.appendFileSync(file, line({ type: 'user', isMeta: true, timestamp: new Date(now + 3 * 3600000 - 60000).toISOString(), origin: { kind: 'peer', name: 'WY-qa', msg_id: 'q2', body: 'P2-01 다시 확인' }, message: { role: 'user', content: '…' } }) + '\n');
    view.refresh();
    assert.strictEqual(kinds(latest())['P2-01'], 'running', '깨어남');
    fs.rmSync(path.join(root, 'requests', 'card-browser.json'));
  } finally {
    fake.uninstall();
  }
});

test('대화 기록 폴더가 없으면 그 경로를 알린다', () => {
  const { fake, view, dir } = setup();
  try {
    const { ActivityReader } = require(path.join(EXT, 'sessionActivity.js'));
    view.reader = new ActivityReader({ dir: path.join(dir, '없는-폴더') });
    fake.commands['wyActivity.open']();
    const panel = fake.panels.find((p) => p.type === 'wyActivity');
    panel.send({ type: 'ready' });
    const st = panel.posts.filter((m) => m.type === 'state').pop().state;
    assert.strictEqual(st.transcriptsMissing, path.join(dir, '없는-폴더'));
    assert.ok(Array.isArray(st.sessions) && st.sessions.length, '세션 칩은 그대로');
  } finally {
    fake.uninstall();
  }
});

test('열린 폴더가 없으면 오류 상태를 보낸다', () => {
  const fake = install({ workspace: null });
  try {
    require(path.join(EXT, 'activityView.js')).register(fake.context);
    fake.commands['wyActivity.open']();
    const panel = fake.panels[0];
    panel.send({ type: 'ready' });
    assert.match(panel.posts.pop().state.error, /열린 폴더가 없어/);
  } finally {
    fake.uninstall();
  }
});

// 승인 폴더와 검사마다 만든 대화 기록 폴더를 모든 검사가 끝나면(실패해도) 지운다
test.after(() => [process.env.WY_APPROVALS_DIR, ...made].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test("보기 이름은 '스레드'(화면 문구에 '묶음'이 남지 않음)", () => {
  const html = fs.readFileSync(path.join(EXT, 'media', 'activity.html'), 'utf8');
  assert.match(html, /data-mode="threads"[^>]*>스레드</, '탭 버튼');
  // 주석을 뺀 문자열 안에 '묶음'이 없어야 한다(aria·빈 상태·범례)
  const js = fs.readFileSync(path.join(EXT, 'media', 'activity.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/묶음/.test(js) && !/>[^<]*묶음/.test(html), "화면 문구에 '묶음' 없음");
  assert.ok(js.includes('진행 중인 스레드가 없습니다.') && js.includes('진행 중인 스레드</span>'), '빈 상태·범례');
});
