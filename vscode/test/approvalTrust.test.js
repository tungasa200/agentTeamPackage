// 승인 센터 기기 신뢰(접속 기기 N대) 검사: 기기마다 globalState가 따로인 승인 센터 여러 개가 같은 승인 폴더를 본다.
//   node vscode/test/approvalTrust.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-trust-'));
process.env.WY_APPROVALS_DIR = path.join(base, 'approvals');
const proj = path.join(base, 'proj');
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
fs.writeFileSync(path.join(proj, '.claude', 'wy-ops.json'), JSON.stringify({ commitRole: 'WY-commit', approvals: { namespace: 'ns' } }));
const root = path.join(process.env.WY_APPROVALS_DIR, 'ns');
const dir = (...x) => path.join(root, ...x);

const { install, EXT } = require('./fakeVscode');
const writeReq = (id) => {
  fs.mkdirSync(dir('requests'), { recursive: true });
  fs.writeFileSync(dir('requests', `${id}.json`), JSON.stringify({ kind: 'commit', session: 'WY-commit', createdAt: new Date().toISOString(), title: id, command: `git commit -F ${id}`, what: '커밋', why: '시험', onClick: '실행' }));
};
const forge = (id, extra = {}) => {
  fs.mkdirSync(dir('decisions'), { recursive: true });
  fs.writeFileSync(dir('decisions', `${id}.json`), JSON.stringify({ id, decision: 'approved', kind: 'commit', command: `git commit -F ${id}`, ...extra }));
};

// 기기 하나 = 따로 된 globalState를 가진 가짜 VS Code 하나. memento를 주면 같은 기기의 다른 창
const centers = [];
function device(name, memento) {
  const fake = install({ workspace: proj });
  fake.vscode.env.machineId = name;
  if (memento) for (const [k, v] of memento) fake.globalState.set(k, v);
  const file = path.join(EXT, 'agentsReader.js');
  require.cache[require.resolve(file)] = { id: file, filename: file, loaded: true, exports: { readSessionStatus: async () => [] } };
  const { ApprovalCenter } = require(path.join(EXT, 'approvalCenter.js'));
  const center = new ApprovalCenter(fake.context);
  centers.push(center);
  fake.commands['wyApprovals.open']();
  const panel = fake.panels[0];
  panel.send({ type: 'ready' });
  const d = {
    fake, center, panel,
    send: (m) => panel.send(m),
    state: () => {
      center.reload();
      return panel.posts.filter((m) => m.type === 'state').pop().state;
    },
    lastError: () => (panel.posts.filter((m) => m.type === 'error').pop() || {}).message,
  };
  fake.uninstall(); // 다음 기기를 불러올 수 있게 require 가로채기만 되돌린다(이 기기의 센터는 계속 돈다)
  return d;
}

(async () => {
  const trust = require(path.join(EXT, 'approvalTrust.js'));

  // 1) 첫 기기: 명부가 없으면 자기가 뿌리(사용자 손 없음)
  const A = device('aaaa1111');
  let sa = A.state();
  assert.strictEqual(sa.devices.selfStatus, 'member', '첫 기기는 자동 뿌리');
  assert.strictEqual(sa.devices.list.length, 1);
  assert.strictEqual(sa.devices.root.fp, sa.devices.selfFp);
  assert.strictEqual(sa.devices.selfName, '이 PC aaaa', '기본 이름: 창 종류 + 기기 id');
  writeReq('c1');
  A.send({ type: 'decide', id: 'c1', decision: 'approved' });
  assert.ok(fs.existsSync(dir('decisions', 'trust', 'sigs', 'c1.json')), '결정 서명');
  assert.deepStrictEqual(A.state().untrusted, [], '자기가 쓴 결정은 신뢰');

  // 2) 두 번째 기기(노트북 원격 창): 미등록. 원장을 처음 만들 때 있던 결정(c1)은 기존 규칙대로 믿고,
  //    그 뒤 A가 쓴 결정은 명부를 신뢰하기 전까지 출처 불명
  const B = device('bbbb2222');
  writeReq('c1b');
  A.send({ type: 'decide', id: 'c1b', decision: 'approved' });
  let sb = B.state();
  assert.strictEqual(sb.devices.selfStatus, 'unpaired', '두 번째 기기는 미등록');
  assert.strictEqual(sb.devices.root.fp, sa.devices.selfFp, '뿌리 지문 = A의 지문(사용자가 비교)');
  assert.deepStrictEqual(sb.untrusted, ['c1b'], '명부를 신뢰하기 전에는 경고');
  assert.deepStrictEqual(sb.devices.joins, [], '미등록 기기에는 등록 요청 카드가 없음');

  // 지문이 다르면 고정하지 않는다
  B.send({ type: 'pinRoot', fp: 'f'.repeat(64), name: '노트북' });
  assert.ok(/뿌리가 바뀌었/.test(B.lastError()), '다른 지문은 거부');
  B.send({ type: 'pinRoot', fp: sb.devices.root.fp, name: '노트북' });
  sb = B.state();
  assert.strictEqual(sb.devices.selfStatus, 'pending', '뿌리 고정 → 등록 승인 대기');
  assert.deepStrictEqual(sb.untrusted, [], '뿌리를 고정하면 A의 결정은 신뢰');

  // B는 아직 승인할 수 없다(신뢰된 기기에서만)
  B.send({ type: 'approveJoin', fp: sb.devices.selfFp });
  assert.ok(/등록된 기기에서만/.test(B.lastError()), '미등록 기기는 승인 못 함');

  // A에 등록 요청 카드, 상태 표시줄에도 센다
  sa = A.state();
  assert.deepStrictEqual(sa.devices.joins.map((j) => [j.fp, j.name]), [[sb.devices.selfFp, '노트북']], 'A에 등록 요청');
  assert.ok(/기기 등록 1건/.test(A.fake.statusItems[0].tooltip), '상태 표시줄에 등록 요청 수');
  A.send({ type: 'approveJoin', fp: sb.devices.selfFp });
  sb = B.state();
  assert.strictEqual(sb.devices.selfStatus, 'member', 'A가 승인 → B 등록');
  sa = A.state();
  assert.deepStrictEqual(sa.devices.joins, [], '승인한 요청은 사라짐');
  assert.strictEqual(sa.devices.list.find((d) => d.fp === sb.devices.selfFp).byName, '이 PC aaaa', '보증한 기기 이름');

  // 요구 1) 어느 창이 쓴 결정이든 서로 경고하지 않는다
  writeReq('c2');
  B.send({ type: 'decide', id: 'c2', decision: 'approved' });
  assert.deepStrictEqual(A.state().untrusted, [], 'B가 쓴 결정을 A가 신뢰');
  assert.deepStrictEqual(B.state().untrusted, [], 'A가 쓴 결정을 B가 신뢰');

  // 요구 2) 세션이 직접 만든 결정은 계속 잡는다
  forge('f1');
  assert.deepStrictEqual(A.state().untrusted, ['f1'], '위조 결정 → A 경고');
  assert.deepStrictEqual(B.state().untrusted, ['f1'], '위조 결정 → B 경고');
  forge('c2', { reason: '바꿔 씀' });
  assert.ok(A.state().untrusted.includes('c2'), '서명한 뒤 내용이 바뀌면 경고');
  // 자기 키로 서명을 만들어 넣어도(명부에 없는 키) 신뢰하지 않는다
  const evil = trust.newKey();
  forge('f2');
  trust.signDecision(root, evil, 'f2', require(path.join(EXT, 'approvalStore.js')).decisionDigest(fs.readFileSync(dir('decisions', 'f2.json'), 'utf8')));
  assert.ok(A.state().untrusted.includes('f2'), '모르는 키의 서명은 무효');
  // 명부에 자기 키를 보증 진술로 끼워 넣어도(서명자가 신뢰 밖) 신뢰하지 않는다
  const roster = trust.readRoster(root);
  const evilFp = trust.fingerprint(evil.pub);
  roster.push(trust.sign(evil, { type: 'add', pub: evil.pub, name: '가짜', at: new Date().toISOString(), by: evilFp }));
  fs.writeFileSync(dir('decisions', 'trust', 'devices.json'), JSON.stringify({ schema: 1, entries: roster }));
  assert.ok(A.state().untrusted.includes('f2'), '자기 보증은 무효');
  assert.strictEqual(A.state().devices.list.find((d) => d.fp === evilFp).state, 'unknown', '목록에는 확인 안 됨으로');
  // 가짜 등록 요청은 사용자 승인 없이는 아무것도 바꾸지 않는다(카드만 뜬다)
  trust.requestJoin(root, evil, '가짜 노트북');
  assert.ok(A.state().devices.joins.some((j) => j.fp === evilFp), '가짜 요청도 카드로(지문 비교로 거절)');
  A.send({ type: 'rejectJoin', fp: evilFp });
  assert.ok(!A.state().devices.joins.some((j) => j.fp === evilFp), '거절 → 사라짐');

  // 3) 세 번째 기기: B가 승인해도 A가 사슬로 신뢰(기기마다 1회)
  const C = device('cccc3333');
  C.send({ type: 'pinRoot', fp: C.state().devices.root.fp, name: '노트북2' });
  const cFp = C.state().devices.selfFp;
  B.send({ type: 'approveJoin', fp: cFp });
  assert.strictEqual(C.state().devices.selfStatus, 'member', 'B의 승인으로 C 등록');
  writeReq('c3');
  C.send({ type: 'decide', id: 'c3', decision: 'approved' });
  assert.ok(!A.state().untrusted.includes('c3'), 'A가 C를 사슬로 신뢰');
  assert.strictEqual(A.state().devices.list.filter((d) => d.state === 'trusted').length, 3, '기기 3대');

  // 같은 기기의 다른 창은 키를 함께 쓴다(새 기기가 아님)
  const A2 = device('aaaa1111', A.fake.globalState);
  assert.strictEqual(A2.state().devices.selfFp, sa.devices.selfFp, '같은 기기 = 같은 키');
  assert.strictEqual(A2.state().devices.selfStatus, 'member');

  // 4) 해제: A가 B를 해제. 해제 전 B의 서명은 그대로, 해제 뒤 B의 서명은 경고. B가 보증한 C는 유지
  writeReq('c4');
  B.send({ type: 'decide', id: 'c4', decision: 'approved' });
  A.send({ type: 'revokeDevice', fp: sa.devices.selfFp });
  assert.ok(/다른 기기에서 해제/.test(A.lastError()), '자기 자신은 해제 못 함');
  A.send({ type: 'revokeDevice', fp: sb.devices.selfFp });
  sa = A.state();
  assert.strictEqual(sa.devices.list.find((d) => d.fp === sb.devices.selfFp).state, 'revoked', 'B 해제됨');
  assert.ok(!sa.untrusted.includes('c4'), '해제 전 서명은 그대로 신뢰');
  assert.strictEqual(B.state().devices.selfStatus, 'revoked', 'B 창에 해제 표시');
  writeReq('c5');
  B.send({ type: 'decide', id: 'c5', decision: 'approved' });
  assert.ok(A.state().untrusted.includes('c5'), '해제 뒤 B의 서명은 경고');
  assert.ok(C.state().untrusted.includes('c5'), 'C도 경고');
  assert.ok(!A.state().untrusted.includes('c3'), 'B가 보증했던 C는 유지');
  assert.strictEqual(C.state().devices.selfStatus, 'member', 'C는 계속 등록 상태');

  // 5) 쌓인 경고 정리: 모두 확인함 → 지금 내용만, 바뀌면 다시
  assert.ok(A.state().untrusted.length >= 2);
  A.send({ type: 'ackAllUntrusted' });
  assert.deepStrictEqual(A.state().untrusted, [], '모두 확인함');
  forge('f1', { note: '또 바꿈' });
  assert.deepStrictEqual(A.state().untrusted, ['f1'], '확인 뒤 바뀌면 다시 경고');

  // doctor 요약
  assert.deepStrictEqual(trust.summary(root), { devices: 2, revoked: 1, unknown: 1, joins: 0 }, 'doctor 요약(가짜 키는 확인 안 됨)');

  for (const c of centers) c.dispose();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('approvalTrust 검사 통과');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
