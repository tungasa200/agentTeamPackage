// 승인 센터 B2-1 검사: 출처 대조(위조 결정 경고), 커밋 세션 역할 누락 경고, 세션 등록 기록
//   node tools/wy-ops/vscode/test/approvals.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-appr-'));
process.env.WY_APPROVALS_DIR = path.join(base, 'approvals');
const proj = path.join(base, 'proj');
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
fs.writeFileSync(path.join(proj, '.claude', 'wy-ops.json'), JSON.stringify({ commitRole: 'WY-commit', approvals: { namespace: 'ns' } }));
const root = path.join(process.env.WY_APPROVALS_DIR, 'ns');
const dir = (x) => path.join(root, x);

const { install, EXT } = require('./fakeVscode');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeReq = (id, o) => {
  fs.mkdirSync(dir('requests'), { recursive: true });
  fs.writeFileSync(path.join(dir('requests'), `${id}.json`), JSON.stringify({ kind: 'commit', session: 'WY-commit', createdAt: new Date().toISOString(), title: id, command: `git commit -F ${id}`, what: '커밋', why: '시험', onClick: '실행', ...o }));
};
const forge = (id, extra = {}) => {
  fs.mkdirSync(dir('decisions'), { recursive: true });
  fs.writeFileSync(path.join(dir('decisions'), `${id}.json`), JSON.stringify({ id, decision: 'approved', kind: 'commit', command: `git commit -F ${id}`, decidedAt: new Date().toISOString(), ...extra }));
};

// 가짜 agentsReader(WY-backend1 모듈 대신): 커밋 세션이 역할 없이 떠 있다고 답한다
let rows = [];
function stubAgents() {
  const file = path.join(EXT, 'agentsReader.js');
  require.cache[require.resolve(file)] = { id: file, filename: file, loaded: true, exports: { readSessionStatus: async () => rows } };
}

(async () => {
  // 원장 시작 전에 있던 결정은 신뢰한다
  writeReq('old1');
  forge('old1');

  let fake = install({ workspace: proj });
  stubAgents();
  const { ApprovalCenter } = require(path.join(EXT, 'approvalCenter.js'));
  let center = new ApprovalCenter(fake.context);
  // B1 행 표시용 상태 읽기 타이머가 테스트를 붙잡지 않게 바로 확인만 한다
  fake.commands['wyApprovals.open']();
  let panel = fake.panels[0];
  panel.send({ type: 'ready' });
  const last = () => panel.posts.filter((m) => m.type === 'state').pop().state;
  assert.deepStrictEqual(last().untrusted, [], '원장 시작 전 결정은 신뢰');

  // 승인 센터가 쓴 결정은 경고 없음
  writeReq('c1');
  center.reload();
  panel.send({ type: 'decide', id: 'c1', decision: 'approved' });
  assert.ok(fs.existsSync(path.join(dir('decisions'), 'c1.json')), '결정 파일');
  assert.deepStrictEqual(last().untrusted, [], '확장이 쓴 결정은 신뢰');

  // 직접 만든 결정(위조) → 출처 불명 경고
  writeReq('c2');
  forge('c2');
  center.reload();
  assert.deepStrictEqual(last().untrusted, ['c2'], '위조 결정 경고');
  assert.ok(last().alerts.some((a) => a.includes('출처 불명') && a.includes('c2')), '경고 문구');

  // 확장이 쓴 결정을 바꿔 쓰면 다시 경고
  forge('c1', { reason: '바꿔 씀' });
  center.reload();
  assert.deepStrictEqual(last().untrusted.sort(), ['c1', 'c2'], '내용이 바뀐 결정 경고');

  // 확인함 → 같은 내용이면 숨김, 내용이 또 바뀌면 다시
  panel.send({ type: 'ackUntrusted', id: 'c2' });
  assert.deepStrictEqual(last().untrusted, ['c1'], '확인한 것은 숨김');
  forge('c2', { note: '또 바꿈' });
  center.reload();
  assert.ok(last().untrusted.includes('c2'), '확인 뒤 다시 바뀌면 경고');

  // 역할 누락 경고(agentsReader가 roleMissing을 알려 줌)
  rows = [
    { name: 'WY-commit', id: 'abcd1234', sessionId: 's-1', roleMissing: true, alive: true },
    { name: 'WY-qa', id: 'q1', sessionId: 's-2', roleMissing: true, alive: true },
    { name: 'WY-commit', id: 'old', sessionId: 's-0', roleMissing: true, alive: false },
  ];
  await center.checkRoles();
  assert.deepStrictEqual(last().roleWarnings, [{ name: 'WY-commit', id: 'abcd1234', sessionId: 's-1' }], '살아 있는 커밋 세션만 경고');
  assert.ok(last().alerts.some((a) => a.includes('커밋 세션 역할 누락') && a.includes('rotate WY-commit none')), '역할 경고 문구');
  rows = [{ name: 'WY-commit', id: 'abcd1234', sessionId: 's-1', roleMissing: false, alive: true }];
  await center.checkRoles();
  assert.deepStrictEqual(last().roleWarnings, [], '역할이 맞으면 경고 사라짐');

  // 할 일 카드 '완료'(B2-3)과 세션이 끝난 카드 표시(B2-4)
  fs.mkdirSync(dir('requests'), { recursive: true });
  fs.writeFileSync(path.join(dir('requests'), 't1.json'), JSON.stringify({ kind: 'todo', session: 'WY-qa', sessionId: 's-dead', title: '직접 실행', what: 'npm ci', why: '분류기 거부', onClick: '완료', steps: ['실행'] }));
  rows = [{ name: 'WY-qa', id: 'q', sessionId: 's-dead', alive: false }];
  await center.checkRoles();
  const t1 = last().pending.find((r) => r.id === 't1');
  assert.strictEqual(t1.sessionEnded, true, '끝난 세션의 카드 표시');
  assert.ok(/할 일 1건/.test(fake.statusItems[0].tooltip), '상태 표시줄에 할 일 수');
  panel.send({ type: 'done', id: 't1', note: '했음' });
  assert.ok(!last().pending.some((r) => r.id === 't1'), '완료 → 닫힘');
  assert.ok(!last().untrusted.includes('t1'), '확장이 쓴 완료 결정은 신뢰');
  panel.send({ type: 'reveal', sessionId: 's-dead' });
  assert.deepStrictEqual(fake.executed.pop(), ['wyOps.revealSession', 's-dead'], '세션 현황에서 보기');

  // VS Code를 다시 켜도 원장은 남는다(globalState)
  const memento = fake.globalState;
  fake.uninstall();
  fake = install({ workspace: proj });
  for (const [k, v] of memento) fake.globalState.set(k, v);
  stubAgents();
  center.dispose();
  center = new (require(path.join(EXT, 'approvalCenter.js')).ApprovalCenter)(fake.context);
  fake.commands['wyApprovals.open']();
  panel = fake.panels[0];
  panel.send({ type: 'ready' });
  assert.ok(last().untrusted.includes('c1') && last().untrusted.includes('c2') && !last().untrusted.includes('old1'), '다시 켜도 같은 판단');

  // 세션 등록 훅(SessionStart)이 쓰고 승인 센터가 읽는다
  const store = require(path.join(EXT, 'approvalStore.js'));
  const { record } = require(path.join(EXT, 'hooks', 'wy-session-start.js'));
  assert.strictEqual(record({ session_id: 'bad id!', cwd: proj }), null, '이상한 세션 ID는 기록 안 함');
  record({ session_id: 'sess-0001', agent_type: 'WY-commit', cwd: proj, source: 'startup' });
  record({ session_id: 'sess-0002', cwd: proj, source: 'resume' });
  fs.writeFileSync(path.join(dir('sessions'), 'bad.json'), '{oops');
  const reg = store.readSessionRegistry(root);
  assert.strictEqual(reg.size, 2, '깨진 기록은 건너뜀');
  assert.strictEqual(reg.get('sess-0001').agentType, 'WY-commit', '역할 기록');
  assert.strictEqual(reg.get('sess-0002').agentType, null, '역할 없이 뜬 세션');

  fake.uninstall();
  center.dispose();
  await sleep(10);
  fs.rmSync(base, { recursive: true, force: true });
  console.log('approvals B2-1 검사 통과');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
