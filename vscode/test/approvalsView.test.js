// 승인 센터 화면(B2-5): 확장 연결(html 자리표시, 활동 탭 열기, 세션 현황에서 보기)과 화면 동작(카드 종류·처리·단축키).
//   node tools/wy-ops/vscode/test/approvalsView.test.js
// 화면 동작 검사는 jsdom이 필요하다. 저장소의 frontend/node_modules에 있으면 쓰고, 없으면 그 부분만 건너뛴다.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.WY_APPROVALS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-apv-'));
const { install, EXT, REPO } = require('./fakeVscode');

const MEDIA = path.join(EXT, 'media');
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const card = (o) => ({ relatedSessions: [], what: '무엇', why: '왜', onClick: '누르면', detail: '', cost: '', createdAt: iso(5), session: 'WY-pm', ...o });
const STATE = {
  root: 'C:\\x\\ns', kinds: { commit: '커밋', 'force-push': '강제 푸시', choice: '결정 요청', permission: '권한 요청', todo: '할 일' }, routineKinds: ['commit', 'push'],
  untrusted: ['f1', 'f2'], roleWarnings: [{ name: 'WY-commit', id: 'abc' }], notice: '', error: '', alerts: [],
  pending: [
    card({ id: 'p1', kind: 'permission', title: '권한 요청', session: 'WY-backend1', sessionId: 'sid-1', tool: 'Bash', command: 'npm test', expiresAt: new Date(now + 10 * 60000).toISOString(), createdAt: iso(5) }),
    card({ id: 'p0', kind: 'permission', title: '기한 지난 권한', sessionId: 'sid-0', tool: 'Bash', command: 'x', expiresAt: iso(1), createdAt: iso(16) }),
    card({ id: 'c1', kind: 'choice', title: '결정', background: '', questions: [
      { question: 'Q1', header: 'h', multiSelect: false, allowOther: true, options: [{ label: 'A', description: '', cost: 'A의 대가', onClick: 'A를 고르면', recommended: true }, { label: 'B', description: '', cost: 'B의 대가', onClick: '' }] }] }),
    card({ id: 'g1', kind: 'force-push', title: '강제 푸시', branch: 'main', command: 'git push -f', commits: [], files: [], fileCount: null, verification: '' }),
    card({ id: 't1', kind: 'todo', title: '할 일', sessionId: 'sid-2', steps: ['하나', '`둘`'], check: '목록에 보이면 됨', sessionEnded: true }),
    { id: 'b1', broken: '필수 필드 누락: what' },
  ],
  recent: [{ id: 'r1', decision: 'done', kind: 'todo', session: 'WY-pm', note: '메모', decidedAt: iso(60), request: null }],
};

function extensionWiring() {
  const fake = install({ workspace: REPO });
  try {
    require(path.join(EXT, 'extension.js')).activate(fake.context);
    fake.commands['wyApprovals.open']();
    const panel = fake.panels.find((p) => p.type === 'wyApprovals');
    assert.ok(panel, '승인 센터 탭');
    assert.ok(!/{{\w+}}/.test(panel.webview.html), 'html 자리표시가 모두 채워짐');
    assert.ok(panel.webview.html.includes('approvals.js') && panel.webview.html.includes('id="app"'), '화면 스크립트와 틀');
    panel.send({ type: 'openActivity' });
    assert.ok(fake.executed.some((e) => e[0] === 'wyActivity.open'), '활동 탭 열기');
    panel.send({ type: 'reveal', sessionId: 'sid-1' });
    assert.ok(fake.executed.some((e) => e[0] === 'wyOps.revealSession' && e[1] === 'sid-1'), '세션 현황에서 보기');
  } finally {
    fake.uninstall();
  }
}

function findJsdom() {
  try {
    return require(require.resolve('jsdom', { paths: [path.join(REPO, 'frontend')] }));
  } catch {
    return null;
  }
}

function screen(jsdom, width) {
  const html = fs.readFileSync(path.join(MEDIA, 'approvals.html'), 'utf8').replace(/<script[^>]*><\/script>/, '');
  const dom = new jsdom.JSDOM(html, { runScripts: 'outside-only' });
  const w = dom.window;
  const posted = [];
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.message));
  w.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) }); // 창 쪽 객체라 이쪽 객체로 옮긴다
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0; // 30초 갱신은 검사에서 돌리지 않는다
  Object.defineProperty(w.document.getElementById('app'), 'clientWidth', { get: () => width });
  w.eval(fs.readFileSync(path.join(MEDIA, 'approvals.js'), 'utf8'));
  const d = w.document;
  return {
    w, d, posted, errors,
    send: (m) => w.dispatchEvent(new w.MessageEvent('message', { data: m })),
    key: (k) => (d.activeElement || d.body).dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true })),
    txt: (s) => [...d.querySelectorAll(s)].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
    id: (x) => d.getElementById(x),
  };
}

function screenBehavior(jsdom) {
  const s = screen(jsdom, 1000);
  assert.deepStrictEqual(s.posted.map((m) => m.type), ['ready'], '처음에 ready');
  s.send({ type: 'state', state: STATE });
  assert.deepStrictEqual(s.txt('.grp').map((t) => t.replace(/\s\d+$/, '')), ['차단', '결정 대기', '할 일', '형식 오류'], '묶음 순서');
  assert.strictEqual(s.id('dt-title').textContent, '기한 지난 권한', '넓은 폭은 첫 카드를 고름(오래된 순)');
  // 경고는 둘만 보이고 나머지는 접힘
  assert.strictEqual(s.d.querySelectorAll('.alert').length, 2, '경고 2개만');
  assert.ok(s.id('alerts-more'), '경고 더 보기');

  // 기한 지난 권한은 허용할 수 없다
  assert.strictEqual(s.id('approve-p0').getAttribute('aria-disabled'), 'true', '기한 지난 권한 허용 막힘');
  s.key('a');
  assert.ok(!s.posted.some((m) => m.id === 'p0'), 'a 키도 막힘');

  // 권한: 사유 없는 거부는 오류, 사유를 쓰면 보냄. 세션 현황 링크
  s.send({ type: 'select', id: 'p1' });
  assert.ok(s.txt('.timer-h b')[0].endsWith('분 남음'), '남은 시간');
  s.id('reveal-p1').click();
  assert.ok(s.posted.some((m) => m.type === 'reveal' && m.sessionId === 'sid-1'), '세션 현황에서 보기');
  s.key('x');
  s.id('confirm-p1').click();
  assert.ok(s.txt('.act .err-line')[0].includes('거부 사유'), '사유 필수');
  assert.strictEqual(s.d.activeElement.id, 'reason-p1', '사유 칸으로 포커스');
  const ta = s.id('reason-p1');
  ta.value = 'CI에서';
  ta.dispatchEvent(new s.w.Event('input'));
  s.id('confirm-p1').click();
  s.id('confirm-p1').click(); // 두 번 눌러도 한 번만
  assert.deepStrictEqual(s.posted.filter((m) => m.type === 'decide'), [{ id: 'p1', type: 'decide', decision: 'rejected', reason: 'CI에서' }], '거부 한 번');

  // 결정: 선택지 대가, 고른 선택지의 onClick, 답하지 않으면 오류
  s.send({ type: 'select', id: 'c1' });
  assert.deepStrictEqual(s.txt('.opt .cost'), ['A의 대가', 'B의 대가'], '선택지별 대가');
  s.key('a');
  assert.ok(s.txt('.err-line').some((t) => t.includes('답해 주세요')), '답 없음 오류');
  s.key('1');
  assert.ok(s.txt('.act .then')[0].includes('A를 고르면'), '고른 선택지의 onClick');
  s.key('a');
  assert.deepStrictEqual(s.posted.find((m) => m.type === 'answer'), { id: 'c1', type: 'answer', answers: [{ selected: ['A'], other: '' }], note: '' }, '답 보내기');

  // 처리된 카드가 사라지면 같은 자리의 다음 카드로
  s.send({ type: 'state', state: { ...STATE, pending: STATE.pending.filter((r) => r.id !== 'c1'), recent: [{ id: 'c1', decision: 'answered', kind: 'choice', decidedAt: new Date().toISOString(), answers: [{ selected: ['A'] }] }, ...STATE.recent] } });
  assert.strictEqual(s.id('dt-title').textContent, '강제 푸시', '다음 카드');
  assert.ok(s.id('announce').textContent.startsWith('답을 보냈습니다'), '처리 알림');
  assert.ok(s.txt('.who-row .mc').length && s.txt('.row .mc').includes('PM 결정'), 'PM 결정 칩');

  // 할 일: 단계 체크, 확인 방법, 세션 끝남, 완료
  s.send({ type: 'select', id: 't1' });
  assert.ok(s.txt('.who-row .mc').some((t) => t.startsWith('세션 종료됨')), '세션 종료됨 표시');
  assert.ok(s.txt('.blk-h').includes('확인 방법'), '확인 방법');
  s.id('tick-t1-0').click();
  assert.strictEqual(s.id('tick-t1-0').getAttribute('aria-checked'), 'true', '단계 체크');
  s.key('a');
  assert.ok(s.posted.some((m) => m.type === 'done' && m.id === 't1'), '완료');

  // 형식 오류: 처리 버튼 없음
  s.send({ type: 'select', id: 'b1' });
  assert.deepStrictEqual(s.txt('.act .btns button'), ['요청 폴더 열기'], '형식 오류는 처리 불가');

  // j/k 이동, 처리됨 탭, g a, 빈 상태
  s.key('k');
  assert.strictEqual(s.id('dt-title').textContent, '할 일', 'k 이동');
  s.id('tab-hist').click();
  assert.ok(s.txt('.hist .how').some((t) => t.includes('완료 · 메모: 메모')), '처리됨');
  s.key('g');
  s.key('a');
  assert.ok(s.posted.some((m) => m.type === 'openActivity'), 'g a 활동 탭');
  s.send({ type: 'state', state: { ...STATE, pending: [], untrusted: [], roleWarnings: [] } });
  s.id('tab-inbox').click();
  assert.deepStrictEqual(s.txt('.empty h2'), ['모두 처리했습니다'], '빈 상태');
  // 모두 처리: 카드가 있을 때와 같은 2단(빈 목록 + 내용 칸), 내용 칸에는 체크·문구·활동 버튼만
  const body = s.id('view');
  assert.deepStrictEqual([...body.children].map((c) => c.className), ['list-col', 'detail-col empty'], '2단 유지');
  assert.strictEqual(body.querySelector('.list-col').children.length, 0, '목록은 비움');
  assert.deepStrictEqual([...body.querySelector('.empty-in').children].map((c) => c.tagName.toLowerCase() + (c.id ? '#' + c.id : '')), ['svg', 'h2', 'button#empty-activity'], '체크·문구·버튼만');
  assert.ok(!body.querySelector('.empty p, .empty .keys'), '설명 문구 없음');
  assert.ok(s.id('app').classList.contains('all-done'), '좁은 폭에서 내용 칸을 보이는 표시');
  s.id('empty-activity').click();
  assert.strictEqual(s.posted.filter((m) => m.type === 'openActivity').length, 2, '세션 활동 보기');
  s.send({ type: 'state', state: STATE });
  assert.ok(!s.id('app').classList.contains('all-done'), '카드가 오면 all-done 해제');

  // 다른 화면에서 카드 열기: 상태보다 먼저 와도 기다렸다 고른다
  const s2 = screen(jsdom, 400);
  s2.send({ type: 'select', id: 'g1' });
  s2.send({ type: 'state', state: STATE });
  assert.strictEqual(s2.id('dt-title').textContent, '강제 푸시', '먼저 온 select');
  assert.ok(s2.id('app').classList.contains('has-sel'), '좁은 폭은 상세만');
  s2.key('Escape');
  assert.ok(!s2.id('app').classList.contains('has-sel') && s2.d.activeElement.id === 'row-g1', 'Esc로 목록, 그 줄로 포커스');

  // 결정 카드를 스크롤해 내려간 뒤 선택지를 골라도 스크롤이 맨 위로 튀지 않는다(사용자 보고 결함)
  const s3 = screen(jsdom, 1000);
  s3.send({ type: 'state', state: STATE });
  s3.send({ type: 'select', id: 'c1' });
  const dt = s3.d.querySelector('.dt');
  dt.scrollTop = 300;
  s3.id('q-c1-0-o1').click();
  assert.strictEqual(s3.d.querySelector('.dt'), dt, '선택은 상세를 다시 그리지 않음');
  assert.strictEqual(dt.scrollTop, 300, '마우스로 고른 뒤 scrollTop 그대로');
  assert.ok(s3.id('q-c1-0-o1').closest('.opt').classList.contains('is-on') && !s3.id('q-c1-0-o0').closest('.opt').classList.contains('is-on'), '고른 선택지만 켜짐');
  assert.ok(s3.txt('.act .then')[0].includes('누르면'), 'onClick 없는 선택지는 카드 onClick');
  s3.key('1');
  assert.strictEqual(dt.scrollTop, 300, '키보드 1로 고른 뒤 scrollTop 그대로');
  assert.ok(s3.txt('.act .then')[0].includes('A를 고르면'), '키보드 선택도 onClick 갱신');
  s3.id('q-c1-0-oth').click();
  assert.strictEqual(dt.scrollTop, 300, '기타를 골라도 그대로');
  assert.strictEqual(s3.d.activeElement.id, 'q-c1-0-other', '기타는 입력칸으로 포커스');
  // 확장에서 상태가 와서 다시 그려도 읽던 자리 그대로(같은 카드일 때)
  s3.send({ type: 'state', state: { ...STATE, recent: [] } });
  const dt2 = s3.d.querySelector('.dt');
  assert.notStrictEqual(dt2, dt, '상태 메시지는 다시 그림');
  assert.strictEqual(dt2.scrollTop, 300, '다시 그려도 scrollTop 복원');
  assert.ok(s3.id('q-c1-0-oth').checked, '다시 그려도 고른 것 유지');
  // 다른 카드로 옮기면 그 카드는 맨 위부터
  s3.send({ type: 'select', id: 'g1' });
  assert.strictEqual(s3.d.querySelector('.dt').scrollTop, 0, '다른 카드는 맨 위');

  // 분류기가 막은 Bash 명령 할 일: 어느 창에 붙여 넣을지 제목에 쓰고, 판단 안내가 명령 블록보다 위
  const s4 = screen(jsdom, 1000);
  const advice = '대부분은 실행하지 않아도 됩니다.';
  s4.send({ type: 'state', state: { ...STATE, untrusted: [], roleWarnings: [], pending: [card({ id: 'd1', kind: 'todo', title: '막힌 명령', what: advice, sessionId: 'sid-9',
    steps: [advice, 'Bash 명령입니다.'], tool: 'Bash', shell: 'bash', command: 'ls -la | head', commandPowerShell: 'ls | Select-Object -First 10' })] } });
  assert.deepStrictEqual(s4.txt('.blk-h').filter((t) => t.includes('명령') || t.includes('형태')), ['PowerShell에 붙여 넣을 형태 — VS Code PowerShell 터미널용', 'Bash 명령 — Git Bash 창용(PowerShell에서는 실패)'], 'PowerShell 형태 먼저, Bash 원문은 창 이름과 함께');
  assert.deepStrictEqual(s4.txt('.code pre'), ['ls | Select-Object -First 10', 'ls -la | head'], '두 명령');
  assert.strictEqual(s4.d.querySelectorAll('.code .icon-btn').length, 2, '둘 다 복사 버튼');
  const order = [...s4.d.querySelectorAll('.what, .todo-steps, .code')].map((e) => e.className);
  assert.ok(order.indexOf('what') < order.indexOf('code') && order.indexOf('todo-steps') < order.indexOf('code'), '판단 안내가 명령 블록보다 위');
  assert.ok(s4.txt('.row .mc').includes('Bash'), '목록에 셸 칩');

  assert.deepStrictEqual([...s.errors, ...s2.errors, ...s3.errors, ...s4.errors], [], '화면 오류 없음');
}

try {
  extensionWiring();
  const jsdom = findJsdom();
  if (jsdom) screenBehavior(jsdom);
  else console.log('jsdom 없음: 화면 동작 검사는 건너뜀(frontend에서 npm ci 하면 돈다)');
  console.log('approvalsView 검사 통과');
} finally {
  fs.rmSync(process.env.WY_APPROVALS_DIR, { recursive: true, force: true });
}
