// install.js 검사: R4 전환 조건(결정을 기다리는 카드 세기)
//   node tools/wy-ops/test/install.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmTree } = require('../lib/fsx');
const { protectedPending, claudeTrusted } = require('../lib/install');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-inst-'));
const card = (id, o) => {
  fs.mkdirSync(path.join(root, 'requests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'requests', `${id}.json`), JSON.stringify({ session: 'WY-pm', createdAt: new Date().toISOString(), title: id, what: 'w', why: 'y', onClick: 'o', ...o }));
};
try {
  assert.deepStrictEqual(protectedPending(root), [], '빈 대기열');
  // 할 일 카드만 남았으면 통과(R4를 안내하는 할 일 카드 자체가 걸리던 결함)
  card('r4-guide', { kind: 'todo', steps: ['setup 실행'] });
  card('broken-1', { kind: 'commit' }); // command가 없어도 형식은 맞음 — 아래에서 따로 본다
  fs.writeFileSync(path.join(root, 'requests', 'bad.json'), '{ 깨진 파일');
  assert.deepStrictEqual(protectedPending(root), ['broken-1'], '할 일·형식 오류는 세지 않음');
  fs.unlinkSync(path.join(root, 'requests', 'broken-1.json'));
  assert.deepStrictEqual(protectedPending(root), [], 'todo만 남으면 통과');
  // commit 대기 1장이면 멈춤(setup이 이 목록이 비어 있지 않으면 멈춘다)
  card('c1', { kind: 'commit', command: 'git commit -F x' });
  assert.deepStrictEqual(protectedPending(root), ['c1'], 'commit 대기 1장');
  // 결정된 카드·기한 지난 권한 카드는 세지 않음, 대기 중인 결정·권한 카드는 셈
  fs.mkdirSync(path.join(root, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'decisions', 'c1.json'), JSON.stringify({ id: 'c1', decision: 'approved' }));
  card('p-old', { kind: 'permission', command: 'ls', expiresAt: new Date(Date.now() - 1000).toISOString() });
  card('ch1', { kind: 'choice', questions: [{ question: 'q', options: [{ label: 'a', cost: '0' }, { label: 'b', cost: '0' }] }] });
  card('p-new', { kind: 'permission', command: 'ls', expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.deepStrictEqual(protectedPending(root).sort(), ['ch1', 'p-new'], '결정됨·기한 지남은 제외');
  // Claude Code 폴더 신뢰 읽기(~/.claude.json, 읽기만): 정확히 같은 폴더·하위 폴더는 신뢰, 대소문자·구분자 무시, 없는 파일은 모름(null)
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  assert.strictEqual(claudeTrusted('C:/x', home), null, '설정 파일이 없으면 모름');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { 'C:/projects/erp-project': { hasTrustDialogAccepted: true }, 'c:/projects/new': { hasTrustDialogAccepted: false } } }));
  assert.strictEqual(claudeTrusted('C:\\projects\\erp-project', home), true);
  assert.strictEqual(claudeTrusted('c:/Projects/ERP-project/tools/x', home), true, '하위 폴더');
  assert.strictEqual(claudeTrusted('C:/projects/new', home), false, '신뢰 안 함');
  assert.strictEqual(claudeTrusted('C:/projects/erp-project-2', home), false, '이름이 비슷한 다른 폴더');
  console.log('wy-ops install 검사 통과');
} finally {
  rmTree(root);
}
