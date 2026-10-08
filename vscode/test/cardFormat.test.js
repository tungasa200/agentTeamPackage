// B2-2 카드 형식(OPS-03): what·why·onClick 필수, choice 선택지마다 cost 필수
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../approvalStore');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-card-'));
const read = (o) => {
  const file = path.join(dir, 'r.json');
  fs.writeFileSync(file, JSON.stringify(o));
  return store.readRequest(file, 'r');
};
const filled = { what: '무엇을', why: '왜', onClick: '누르면' };
const options = [
  { label: '가', cost: '반나절' },
  { label: '나', cost: '없음', onClick: '나로 진행' },
];
const choice = { kind: 'choice', session: 'WY-pm', ...filled, questions: [{ question: '고르세요', options }] };

// 칸 누락 4종: what·why·onClick 하나씩 빠짐, choice 선택지 cost 빠짐 → 형식 오류 카드
for (const k of ['what', 'why', 'onClick']) {
  const r = read({ kind: 'commit', session: 'WY-commit', command: 'git commit', ...filled, [k]: '  ' });
  assert.strictEqual(r.broken, `필수 필드 누락: ${k}`);
}
assert.strictEqual(read({ kind: 'todo', session: 'x' }).broken, '필수 필드 누락: what, why, onClick');
const noCost = read({ ...choice, questions: [{ question: '고르세요', options: [options[0], { label: '나' }] }] });
assert.strictEqual(noCost.broken, '필수 필드 누락: 1번 질문 선택지 cost(나)');

// 형식 오류 카드는 결정할 수 없다
const p = store.ensureDirs(dir);
fs.writeFileSync(path.join(p.requests, 'bad.json'), JSON.stringify({ kind: 'commit', session: 'x', command: 'git commit' }));
assert.throws(() => store.decide('bad', 'approved', { root: dir }), /필수 필드 누락/);

// 정상 카드는 네 칸을 그대로 넘긴다
const ok = read(choice);
assert.ok(!ok.broken, ok.broken);
assert.deepStrictEqual([ok.what, ok.why, ok.onClick], ['무엇을', '왜', '누르면']);
assert.deepStrictEqual(ok.questions[0].options.map((o) => [o.cost, o.onClick]), [['반나절', ''], ['없음', '나로 진행']]);
const git = read({ kind: 'push', session: 'WY-commit', command: 'git push', ...filled, cost: 'CI 10분' });
assert.strictEqual(git.cost, 'CI 10분');
const todo = read({ kind: 'todo', session: 'x', ...filled, steps: ['실행'], check: '창이 뜸' });
assert.deepStrictEqual([todo.steps, todo.check, todo.cost], [['실행'], '창이 뜸', '']);

fs.rmSync(dir, { recursive: true, force: true });
console.log('cardFormat: ok');
