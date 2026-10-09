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

// git 카드 맨 위 한 줄(effect, 선택 칸): 있으면 그대로, 없으면 kind·branch·commits·files로 만든다
assert.deepStrictEqual([git.effect, git.effectAuto], ['원격 브랜치에 커밋 올림 · revert로 되돌림', true], '칸 없음 → 기본 문구');
const given = read({ kind: 'push', session: 'WY-commit', command: 'git push', ...filled, effect: '  원격 main에 3개 커밋 올림 · revert로 되돌림 ' });
assert.deepStrictEqual([given.effect, given.effectAuto], ['원격 main에 3개 커밋 올림 · revert로 되돌림', false], '칸 있음 → 그대로');
const merged = read({ kind: 'merge', session: 'WY-commit', command: 'gh pr merge 11 --merge', branch: 'main', commits: Array.from({ length: 22 }, (_, i) => ({ hash: String(i), subject: 's' })), ...filled });
assert.strictEqual(merged.effect, '원격 main에 22개 커밋 합침 · revert로 되돌림', 'PR 병합');
const eff = (o) => store.gitEffect({ ...o });
assert.strictEqual(eff({ kind: 'commit', branch: 'feature/P3', files: ['a', 'b'] }), 'feature/P3에 커밋 1개 추가(파일 2개) · 푸시 전이라 되돌리기 쉬움');
assert.strictEqual(eff({ kind: 'reset', command: 'git reset --hard HEAD~1' }), '현재 브랜치를 이전 커밋으로 되돌림, 작업 중 변경도 지움 · 지운 변경은 되찾기 어려움');
assert.strictEqual(eff({ kind: 'delete-branch' }), '브랜치 삭제 · 병합 안 된 커밋은 잃을 수 있음');
assert.strictEqual(todo.effect, undefined, 'git 카드만');

// 형식 오류 카드의 사람 말 설명(fix): 무엇이 틀렸나 + 누구에게 다시 올리게 할지
const pr = read({ kind: 'pr', session: 'WY-commit', ...filled });
assert.strictEqual(pr.broken, '알 수 없는 종류: pr', '기존 broken 문구는 그대로');
assert.ok(/^종류\(kind\) 'pr'는 없는 값 · 쓸 수 있는 값: commit, push, .*merge.* · PR 병합은 merge$/.test(pr.fix.what), pr.fix.what);
assert.ok(!pr.fix.what.includes('permission'), '세션이 직접 쓰지 않는 종류는 안내하지 않음');
assert.deepStrictEqual([pr.fix.session, pr.fix.ask], ['WY-commit', '요청한 세션(WY-commit)에 다시 올리라고 pm에 알리세요']);
assert.strictEqual(read({ kind: 'todo', session: 'x' }).fix.what, '필수 칸 비어 있음: what, why, onClick');
fs.writeFileSync(path.join(dir, 'r.json'), '{"kind": "commit", ');
const half = store.readRequest(path.join(dir, 'r.json'), 'r');
assert.deepStrictEqual([half.fix.what, half.fix.session], ['파일이 JSON이 아니거나 쓰는 중에 읽힘', null], '깨진 JSON');

fs.rmSync(dir, { recursive: true, force: true });
console.log('cardFormat: ok');
