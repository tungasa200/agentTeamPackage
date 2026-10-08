// 세션 상태 읽기(agentsReader, B1-1·B1-3): 네 가지 상태 표와 꺼진 이유, 이름 중복 정리, 권한 요청 붙이기, 역할 누락,
// 꺼진 뒤 막힌 메시지, 메시지 도달 여부.
//   node tools/wy-ops/vscode/test/sessionsReader.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildStatus, isReachable, readMessageBlocks, MESSAGE_BLOCKS } = require('../agentsReader');

const NOW = Date.parse('2026-10-07T12:00:00Z');
const bg = (name, extra) => ({ name, kind: 'background', id: name.slice(-8), sessionId: `${name}-sid`, startedAt: 1, ...extra });
const live = (name, extra) => bg(name, { pid: 100, status: 'busy', state: 'working', ...extra });
const view = (s, opts) => buildStatus([s], { now: NOW, ...opts })[0].view;

// 1. 네 가지 상태(사용자 확정 2026-10-07): 일하는 중·입력 대기·권한 대기·꺼짐(U-01·U-05, B2 답 Q2)
const table = [
  ['일하는 중', live('a'), 'working'],
  ['권한 확인 창', live('a', { state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' }), 'permission'],
  ['샌드박스 허용', live('a', { state: 'blocked', status: 'waiting', waitingFor: 'sandbox request' }), 'permission'],
  ['작업자 요청', live('a', { state: 'blocked', status: 'waiting', waitingFor: 'worker request' }), 'permission'],
  ['질문 대화상자는 입력 대기(U-05)', live('a', { state: 'blocked', status: 'waiting', waitingFor: 'dialog open' }), 'input'],
  ['다음 지시 기다림', live('a', { state: 'blocked', status: 'waiting', waitingFor: 'input needed' }), 'input'],
  ['일을 마치고 살아 있음', live('a', { state: 'done', status: 'idle' }), 'input'],
  ['claude stop으로 멈춤', bg('a', { state: 'stopped' }), 'off'],
  ['스스로 끝남', bg('a', { state: 'done' }), 'off'],
  ['오류로 끝남', bg('a', { state: 'failed' }), 'off'],
  ['VS Code 세션 작업 중', { name: 'p', kind: 'interactive', pid: 1, status: 'busy' }, 'working'],
  ['VS Code 세션 쉬는 중은 입력 대기', { name: 'p', kind: 'interactive', pid: 1, status: 'idle' }, 'input'],
];
for (const [label, s, want] of table) assert.strictEqual(view(s), want, label);

// 꺼짐 안의 두 이유(+오류)는 작은 글씨로 구분한다. 꺼지지 않은 세션은 이유 없음
const reason = (s) => buildStatus([s], { now: NOW })[0].offReason;
assert.strictEqual(reason(bg('a', { state: 'stopped' })), 'stopped', '멈춤');
assert.strictEqual(reason(bg('a', { state: 'done' })), 'done', '스스로 끝남');
assert.strictEqual(reason(bg('a', { state: 'failed' })), 'failed', '오류로 끝남');
assert.strictEqual(reason(live('a', { state: 'done', status: 'idle' })), null, '살아 있으면 꺼짐 아님');

// 2. 이름마다 한 줄: 살아 있는 것 우선, 그다음 최신 startedAt
{
  const rows = buildStatus([
    bg('WY-qa', { state: 'done', startedAt: 30, id: 'old1' }),
    live('WY-qa', { startedAt: 10, id: 'live1' }),
    bg('WY-design', { state: 'stopped', startedAt: 5, id: 'd1' }),
    bg('WY-design', { state: 'done', startedAt: 9, id: 'd2' }),
  ], { now: NOW });
  assert.strictEqual(rows.length, 2, '이름마다 한 줄');
  assert.strictEqual(rows.find((r) => r.name === 'WY-qa').id, 'live1', '살아 있는 것 우선');
  const d = rows.find((r) => r.name === 'WY-design');
  assert.deepStrictEqual([d.id, d.view, d.offReason], ['d2', 'off', 'done'], '모두 꺼졌으면 최신');
}

// 3. 권한 요청 파일: 최신 하나, 결정·만료는 빼고, 살아 있는 세션만 (B2 답 Q2·Q3)
{
  const req = (createdAt, extra) => ({ key: `k${createdAt}`, sessionId: 'a-sid', tool: 'Bash', command: `echo ${createdAt}`,
    createdAt: `2026-10-07T11:5${createdAt}:00Z`, expiresAt: '2026-10-07T12:10:00Z', decision: null, ...extra });
  const requests = [req(1), req(3), req(4, { decision: 'approved' }), req(5, { expiresAt: '2026-10-07T11:59:00Z' })];
  const [row] = buildStatus([live('a')], { requests, now: NOW });
  assert.strictEqual(row.view, 'permission', '파일만 있어도 살아 있으면 권한 대기');
  assert.deepStrictEqual(row.pending, { key: 'k3', tool: 'Bash', command: 'echo 3' }, '결정 전·만료 전 중 최신');

  assert.strictEqual(view(bg('a', { state: 'done' }), { requests }), 'off', '죽은 세션의 남은 파일은 무시');
  const [moved] = buildStatus([live('a')], { requests: [req(4, { decision: 'approved' })], now: NOW });
  assert.deepStrictEqual([moved.view, moved.pending], ['working', null], '결정되면 표시가 사라짐');
  const [noFile] = buildStatus([live('a', { state: 'blocked', waitingFor: 'permission prompt' })], { now: NOW });
  assert.deepStrictEqual([noFile.view, noFile.pending], ['permission', null], '파일이 없으면 명령 없이 권한 대기');
}

// 4. 역할 누락(OPS-06 4): agent:true 역할인데 실제 agent_type이 다름. 기록이 없으면 판단하지 않음
{
  const ops = { roles: [{ name: 'WY-commit', agent: true }, { name: 'WY-pm', agent: false }, { name: 'WY-qa', agent: true }] };
  const missingOf = (rec) => buildStatus([live('WY-commit')], { ops, registry: new Map([['WY-commit-sid', { sessionId: 'WY-commit-sid', ...rec }]]), now: NOW })[0].roleMissing;
  // fork로 이어 띄운 세션: SessionStart가 agent_type을 못 받아 null → 알 수 없음, 경고 없음(2026-10-07 오탐)
  assert.strictEqual(missingOf({ agentType: null, source: 'fork' }), false, 'fork null은 경고 없음');
  // 도구를 쓴 뒤: 가드 훅이 받은 값이 근거
  assert.strictEqual(missingOf({ agentType: null, agentTypeSeen: 'WY-commit', seenAt: 't' }), false, '도구 사용 뒤 실제 역할이 맞으면 경고 없음');
  assert.strictEqual(missingOf({ agentType: null, agentTypeSeen: null, seenAt: 't' }), true, '도구 사용 때 agent_type이 없으면(--agent 없이 뜸) 경고');
  // 실제 불일치
  assert.strictEqual(missingOf({ agentType: 'WY-qa' }), true, '시작 기록이 다른 역할이면 경고');
  assert.strictEqual(missingOf({ agentType: 'WY-commit', agentTypeSeen: 'WY-qa', seenAt: 't' }), true, '도구 사용 때 다른 역할이면 경고(시작 기록보다 우선)');
  assert.strictEqual(missingOf({ agentType: 'WY-commit' }), false, '역할이 맞으면 표시 없음');
  // agent:false 역할·기록 없는 세션은 판단하지 않음
  const registry = new Map([['WY-pm-sid', { sessionId: 'WY-pm-sid', agentType: null, agentTypeSeen: null, seenAt: 't' }]]);
  const rows = buildStatus([live('WY-pm'), live('WY-design')], { ops, registry, now: NOW });
  assert.deepStrictEqual(rows.map((r) => r.roleMissing), [false, false]);
}

// 5. 메시지를 받을 수 있는가(B2 SendMessage 훅과 같은 기준)
{
  const list = [bg('WY-commit', { state: 'done' }), live('WY-qa'), bg('WY-qa', { state: 'done', startedAt: 99 }),
    { name: 'WY-pm', kind: 'interactive', pid: 1, status: 'idle' }];
  assert.strictEqual(isReachable(list, 'WY-commit'), false, '끝난 세션');
  assert.strictEqual(isReachable(list, 'WY-qa'), true, '살아 있는 줄이 하나라도 있으면');
  assert.strictEqual(isReachable(list, 'WY-pm'), true, 'VS Code 세션');
  assert.strictEqual(isReachable(list, 'WY-browser'), false, '목록에 없음');
}

// 6. 모르는 형식은 멈추지 않는다
assert.deepStrictEqual(buildStatus([null, 3, { kind: 'background', state: 'weird' }], { now: NOW }).map((r) => r.view), ['off']);

// 7. 꺼진 뒤 메시지 옴: 메시지 가드(B2-6)의 거부 기록 중 그 세션이 뜬 뒤 그 세션 앞으로 막힌 것만
{
  const t = (h) => `2026-10-07T${h}:00Z`;
  const started = Date.parse(t('09:00'));
  const off = bg('WY-search', { state: 'done', startedAt: started, sessionId: 'search-new' });
  const blocks = [
    { at: t('08:00'), from: 'WY-pm', to: 'WY-search', toSessionId: 'search-old', summary: '교대 전 세션 앞' },
    { at: t('10:00'), from: 'WY-pm', to: 'WY-search', toSessionId: 'search-new', summary: '조사 결과 부탁' },
    { at: t('10:30'), from: 'WY-qa', to: 'WY-search', toSessionId: null, summary: 'id 모르는 기록' },
    { at: t('10:40'), from: 'WY-pm', to: 'WY-qa', toSessionId: 'qa', summary: '다른 세션 앞' },
  ];
  const [row] = buildStatus([off], { blocks, now: NOW });
  assert.deepStrictEqual(row.offMessages.map((m) => m.summary), ['조사 결과 부탁', 'id 모르는 기록'], '꺼진 뒤 막힌 메시지');
  const [quiet] = buildStatus([bg('WY-frontend', { state: 'done', startedAt: started })], { blocks, now: NOW });
  assert.deepStrictEqual(quiet.offMessages, [], '정상으로 끝난 세션은 경고 근거 없음');
  const [alive] = buildStatus([live('WY-search', { sessionId: 'search-new' })], { blocks, now: NOW });
  assert.deepStrictEqual(alive.offMessages, [], '살아 있으면 경고 없음');

  // 기록 파일 읽기: 깨진 줄은 건너뛴다
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-blocks-'));
  try {
    fs.writeFileSync(path.join(dir, MESSAGE_BLOCKS), [JSON.stringify(blocks[1]), '{깨진 줄', '', JSON.stringify({ at: 'x', to: 'a' }), JSON.stringify(blocks[2])].join('\n') + '\n');
    assert.deepStrictEqual(readMessageBlocks(dir).map((b) => b.summary), ['조사 결과 부탁', 'id 모르는 기록'], '기록 읽기');
    assert.deepStrictEqual(readMessageBlocks(path.join(dir, '없음')), [], '파일 없음');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('sessionsReader 검사 통과');
