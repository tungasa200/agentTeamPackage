// 메시지 대상 확인 훅(B2-6) 검사
//   node tools/wy-ops/vscode/test/hooks-message.test.js
const assert = require('assert');
const { check, nameOf } = require('../hooks/wy-message-guard.js');

const bg = (name, state, alive, startedAt) => ({ name, kind: 'background', state, startedAt, ...(alive ? { pid: 1, status: 'idle' } : {}) });
const list = [
  bg('WY-qa', 'done', false, 1),
  bg('WY-commit', 'done', false, 1),
  bg('WY-commit', 'working', true, 2), // 교대 뒤 새 세션
  bg('WY-design', 'stopped', false, 3),
  bg('WY-design', 'failed', false, 5),
  { name: 'WY-pm', kind: 'interactive', state: 'working', startedAt: 1 },
];

assert.strictEqual(nameOf('WY-qa [3fa9c1]'), 'WY-qa');
assert.strictEqual(nameOf(' WY-qa '), 'WY-qa');

const qa = check(list, 'WY-qa');
assert.strictEqual(qa && qa.decision, 'deny', '끝난 세션은 거부');
assert.ok(qa.reason.includes('session.ps1 start WY-qa') && qa.reason.includes('done'), '사유에 상태·다시 띄우는 법');
assert.ok(check(list, 'WY-qa [abc123]'), 'ref가 붙어도 같은 판단');
assert.ok(check(list, 'WY-design').reason.includes('failed'), '가장 최근 세션의 상태');
assert.strictEqual(check(list, 'WY-commit'), null, '같은 이름의 살아 있는 세션이 있으면 통과');
assert.strictEqual(check(list, 'WY-pm'), null, '대화형은 통과');
assert.strictEqual(check(list, 'WY-backend9'), null, '목록에 없는 이름은 통과(하위 에이전트·팀원)');
assert.strictEqual(check(list, 'main'), null, 'main은 통과');
assert.strictEqual(check([], 'WY-qa'), null, '빈 목록은 통과');
assert.strictEqual(check(null, ''), null, '대상 없음은 통과');

// MP-03: 설정(ops)을 주면 이 프로젝트 세션만 본다(worktree에서 보내도 본 저장소 기준)
{
  const ops = { rolePrefix: 'WY-', pmRole: 'WY-pm', root: String.raw`C:\p\tool\.claude\worktrees\WY-dev1` };
  const mixed = [
    { name: 'WY-qa', kind: 'background', state: 'done', cwd: String.raw`C:\p\tool`, startedAt: 1, sessionId: 'mine' },
    { name: 'WY-qa', kind: 'background', state: 'working', status: 'busy', pid: 7, cwd: String.raw`C:\p\erp`, startedAt: 2, sessionId: 'theirs' },
    { name: 'WY-only', kind: 'background', state: 'done', cwd: String.raw`C:\p\erp`, startedAt: 1 },
  ];
  assert.strictEqual(check(mixed, 'WY-qa'), null, '설정 없음: 다른 프로젝트의 살아 있는 같은 이름으로 통과(이전 동작)');
  const r = check(mixed, 'WY-qa', 'WY-pm', ops);
  assert.ok(r && r.toSessionId === 'mine', '이 프로젝트 쪽이 꺼져 있으면 거부');
  assert.strictEqual(check(mixed, 'WY-only', 'WY-pm', ops), null, '다른 프로젝트에만 있는 이름은 목록에 없는 이름처럼 통과');
}

// 거부 기록(message-blocks.log): 본문 없이 시각·보낸 세션·대상, 크기를 넘으면 앞 절반을 버린다
const fs = require('fs');
const os = require('os');
const path = require('path');
const { recordBlock, blockEntry, LOG_NAME } = require('../hooks/wy-message-guard.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-msg-'));
const withIds = [{ ...bg('WY-qa', 'done', false, 1), sessionId: 'qa-sid' }, { name: 'WY-pm', kind: 'interactive', sessionId: 'pm-sid' }];
const input = { session_id: 'pm-sid', tool_input: { to: 'WY-qa [abc]', message: '비밀 본문', summary: '요약' } };
const entry = blockEntry(withIds, input, check(withIds, input.tool_input.to), new Date('2026-10-07T00:00:00Z'));
assert.deepStrictEqual(entry, { at: '2026-10-07T00:00:00.000Z', from: 'WY-pm', fromSessionId: 'pm-sid', to: 'WY-qa', toSessionId: 'qa-sid', toState: 'done' });
assert.strictEqual(blockEntry([], { tool_input: {} }, check(withIds, 'WY-qa')).from, null, '보낸 세션을 모르면 null');
for (let i = 0; i < 10; i++) recordBlock(root, { ...entry, n: i }, 600);
const kept = fs.readFileSync(path.join(root, LOG_NAME), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.ok(fs.statSync(path.join(root, LOG_NAME)).size <= 600, '크기 제한');
assert.strictEqual(kept[kept.length - 1].n, 9, '최근 기록은 남음');
assert.ok(kept[0].n > 0, '앞 기록은 버림');
assert.ok(!fs.readFileSync(path.join(root, LOG_NAME), 'utf8').includes('비밀 본문'), '본문 없음');
fs.rmSync(root, { recursive: true, force: true });

console.log('message 훅 검사 통과');
