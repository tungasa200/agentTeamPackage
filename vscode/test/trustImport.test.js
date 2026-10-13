// 기기 명부 전역화(ENH-01) 검사: 옛 구조(승인 폴더마다 decisions/trust/devices.json, 고정 키 'wyApprovals.anchors:<폴더>')에서
// 전역 명부(바탕 폴더 .trust/)·새 고정 키('wyApprovals.anchors')로 한 번 옮겨 오기.
//   node vscode/test/trustImport.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-trustimp-'));
process.env.WY_APPROVALS_DIR = path.join(base, 'approvals');
const A = process.env.WY_APPROVALS_DIR;
const nsRoot = (ns) => path.join(A, ns);
const legacy = (ns, ...x) => path.join(nsRoot(ns), 'decisions', 'trust', ...x);
const GLOBAL = path.join(A, '.trust', 'devices.json');
const projects = {};
for (const ns of ['ns1', 'ns2', 'ns3']) {
  const p = path.join(base, ns);
  fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'wy-ops.json'), JSON.stringify({ commitRole: 'X-commit', approvals: { namespace: ns } }));
  fs.mkdirSync(path.join(nsRoot(ns), 'requests'), { recursive: true });
  projects[ns] = p;
}

const { install, EXT } = require('./fakeVscode');
const trust = require(path.join(EXT, 'approvalTrust.js'));
const store = require(path.join(EXT, 'approvalStore.js'));
const now = () => new Date().toISOString();
const fpOf = (k) => trust.fingerprint(k.pub);
const rootStmt = (k, name) => trust.sign(k, { type: 'root', pub: k.pub, name, at: now(), by: fpOf(k) });
const addStmt = (by, k, name) => trust.sign(by, { type: 'add', pub: k.pub, name, at: now(), by: fpOf(by) });
const writeLegacy = (ns, entries) => {
  fs.mkdirSync(legacy(ns), { recursive: true });
  fs.writeFileSync(legacy(ns, 'devices.json'), JSON.stringify({ schema: 1, entries }));
};
const oldKey = (ns) => `wyApprovals.anchors:${nsRoot(ns).toLowerCase()}`;
const pin = (k) => [{ fp: fpOf(k), pub: k.pub }];

const centers = [];
function device(ns, key, memento = {}, { remote = false } = {}) {
  const fake = install({ workspace: projects[ns] });
  fake.vscode.env.machineId = fpOf(key).slice(0, 8);
  if (remote) fake.vscode.env.remoteName = 'ssh-remote';
  fake.globalState.set('wyApprovals.deviceKey', key);
  for (const [k, v] of Object.entries(memento)) fake.globalState.set(k, v);
  const file = path.join(EXT, 'agentsReader.js');
  require.cache[require.resolve(file)] = { id: file, filename: file, loaded: true, exports: { readSessionStatus: async () => [] } };
  const { ApprovalCenter } = require(path.join(EXT, 'approvalCenter.js'));
  const center = new ApprovalCenter(fake.context);
  centers.push(center);
  fake.commands['wyApprovals.open']();
  const panel = fake.panels[0];
  panel.send({ type: 'ready' });
  fake.uninstall();
  return {
    fake,
    send: (m) => panel.send(m),
    state: () => {
      center.reload();
      return panel.posts.filter((m) => m.type === 'state').pop().state;
    },
  };
}

(async () => {
  const H = trust.newKey(); // 호스트 로컬 창
  const L = trust.newKey(); // 노트북(ns1에 등록)
  const M = trust.newKey(); // 원격 창(ns2에 등록)
  const X = trust.newKey(); // 다른 뿌리

  // 옛 구조: 호스트가 ns1·ns2에서 따로 뿌리, 등록된 기기는 명부마다 다름. ns2에 기다리는 등록 요청
  writeLegacy('ns1', [rootStmt(H, '이 PC'), addStmt(H, L, '노트북')]);
  writeLegacy('ns2', [rootStmt(H, '이 PC'), addStmt(H, M, '원격 창')]);
  const W = trust.newKey();
  fs.mkdirSync(legacy('ns2', 'join'), { recursive: true });
  fs.writeFileSync(legacy('ns2', 'join', `${fpOf(W)}.json`), JSON.stringify(trust.sign(W, { pub: W.pub, name: '새 노트북', at: now() })));
  const before = fs.readFileSync(legacy('ns1', 'devices.json'), 'utf8');

  // ① 이 기기 키가 뿌리 → 같은 뿌리 명부를 합쳐 전역으로
  const host = device('ns1', H, { [oldKey('ns1')]: pin(H) });
  let s = host.state();
  assert.ok(fs.existsSync(GLOBAL), '전역 명부 생성');
  assert.strictEqual(s.devices.selfStatus, 'member', '호스트는 그대로 등록 상태');
  assert.strictEqual(s.devices.root.fp, fpOf(H));
  assert.deepStrictEqual(s.devices.list.filter((d) => d.state === 'trusted').map((d) => d.name).sort(), ['노트북', '원격 창', '이 PC'], '두 명부의 기기를 합침');
  assert.strictEqual(trust.readRoster().filter((e) => e.type === 'add').length, 2, '보증 진술 둘');
  assert.strictEqual(trust.readRoster()[0].type, 'root', '뿌리 진술이 맨 앞');
  assert.deepStrictEqual(s.devices.joins.map((j) => j.name), ['새 노트북'], '기다리는 등록 요청도 전역으로');
  assert.strictEqual(fs.readFileSync(legacy('ns1', 'devices.json'), 'utf8'), before, '옛 파일은 그대로');
  assert.deepStrictEqual(host.fake.globalState.get('wyApprovals.anchors'), pin(H), '새 고정 키에 이어받음');
  assert.deepStrictEqual(host.fake.globalState.get(oldKey('ns1')), pin(H), '옛 키는 지우지 않음');

  // 다른 프로젝트 창(ns3, 옛 명부 없음)에서도 같은 전역 명부·같은 등록 상태
  const host3 = device('ns3', H, { 'wyApprovals.anchors': pin(H) });
  assert.strictEqual(host3.state().devices.selfStatus, 'member', '프로젝트가 달라도 같은 명부');
  assert.ok(!fs.existsSync(legacy('ns3', 'devices.json')), '승인 폴더에 명부를 새로 만들지 않음');

  // 원격 창: 옛 키(ns2 폴더)로 고정한 뿌리가 전역 뿌리와 같으면 이어받아 바로 등록 상태
  const remote = device('ns1', M, { [oldKey('ns2')]: pin(H) }, { remote: true });
  assert.strictEqual(remote.state().devices.selfStatus, 'member', 'ns2에서 등록된 원격 창은 ns1 창에서도 등록');
  assert.deepStrictEqual(remote.fake.globalState.get('wyApprovals.anchors'), pin(H));

  // 전역 뿌리와 다른 옛 고정은 이어받지 않는다
  const stranger = device('ns1', trust.newKey(), { [oldKey('ns1')]: pin(X) }, { remote: true });
  assert.strictEqual(stranger.state().devices.selfStatus, 'unpaired', '다른 뿌리 고정은 무시');
  assert.strictEqual(stranger.fake.globalState.get('wyApprovals.anchors'), undefined, '이어받을 것이 없으면 새 키를 쓰지 않음');

  // 해제: 다른 승인 폴더(ns2)에서 그 기기가 서명한 결정도 keep에 남는다
  fs.mkdirSync(path.join(nsRoot('ns2'), 'decisions'), { recursive: true });
  const dfile = path.join(nsRoot('ns2'), 'decisions', 'd1.json');
  fs.writeFileSync(dfile, JSON.stringify({ id: 'd1', decision: 'approved', kind: 'commit', command: 'git commit' }));
  trust.signDecision(nsRoot('ns2'), L, 'd1', store.decisionDigest(fs.readFileSync(dfile, 'utf8')));
  host.send({ type: 'revokeDevice', fp: fpOf(L) });
  const rv = trust.readRoster().find((e) => e.type === 'revoke');
  assert.deepStrictEqual(rv.keep.map((k) => k.id), ['d1'], '모든 승인 폴더에서 서명된 결정을 모음');

  // 초기화 명령은 새 키만 비운다
  host3.fake.nextChoice = '초기화';
  await host3.fake.commands['wyApprovals.resetTrustAnchors']();
  assert.deepStrictEqual(host3.fake.globalState.get('wyApprovals.anchors'), [], '새 키 비움');

  // ② / ③ / 못 정함: 전역 명부를 지우고 옛 명부를 다시 고른다
  const reset = () => fs.rmSync(path.join(A, '.trust'), { recursive: true, force: true });
  reset();
  writeLegacy('ns3', [rootStmt(X, '다른 PC')]);
  // 못 정함(뿌리가 다르고 이 기기 고정도 없음): 자동으로 고르지 않음 → 원격 창은 명부 없을 때와 같은 안내
  const r1 = device('ns1', trust.newKey(), {}, { remote: true });
  s = r1.state();
  assert.ok(!fs.existsSync(GLOBAL), '못 정하면 가져오지 않음');
  assert.strictEqual(s.devices.root, null, '명부 없을 때와 같은 화면(호스트 로컬 창을 먼저 여세요)');
  assert.strictEqual(s.devices.remote, true);
  // ② 이 기기가 고정한 뿌리(옛 키 어느 것이든)
  const r2 = device('ns1', M, { [oldKey('ns2')]: pin(X) }, { remote: true });
  assert.strictEqual(trust.rosterRoot(trust.readRoster()).fp, fpOf(X), '고정했던 뿌리의 명부를 가져옴');
  assert.strictEqual(r2.state().devices.root.fp, fpOf(X));
  // ③ 후보 뿌리가 모두 같음
  reset();
  fs.rmSync(legacy('ns3', 'devices.json'));
  // ns2를 ns1 진술 + 보증 하나로(같은 진술은 sig로 한 번만)
  const ns1Entries = JSON.parse(fs.readFileSync(legacy('ns1', 'devices.json'), 'utf8')).entries;
  writeLegacy('ns2', [...ns1Entries, addStmt(H, M, '원격 창')]);
  device('ns1', trust.newKey(), {}, { remote: true });
  assert.strictEqual(trust.rosterRoot(trust.readRoster()).fp, fpOf(H), '뿌리가 하나뿐이면 가져옴');
  assert.strictEqual(trust.readRoster().length, 3, '겹치는 진술은 한 번만, 순서 유지');

  for (const c of centers) c.dispose();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('trustImport 검사 통과');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
