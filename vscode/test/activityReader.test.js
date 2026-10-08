// 활동 읽기 모듈 검사: 실제 대화 기록과 같은 모양의 합성 줄로 확인한다(실제 기록 내용은 저장소에 넣지 않는다)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ActivityReader, transcriptDir, bundle, stageOf, taskId, bareName } = require('../sessionActivity');

const T0 = Date.parse('2026-10-07T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();

const nameLine = (name, sid) => ({ type: 'agent-name', agentName: name, sessionId: sid });
const sendLine = (min, toolId, to, message, summary = '') => ({
  type: 'assistant', timestamp: at(min), sessionId: 's', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'SendMessage', input: { to, summary, message } }] },
});
const sendResult = (min, toolId, msgId) => ({
  type: 'user', timestamp: at(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text: JSON.stringify({ success: true, msg_id: msgId }) }] }] },
  toolUseResult: { success: true, message: '…', msg_id: msgId },
});
const recvLine = (min, from, msgId, body) => ({
  type: 'user', isMeta: true, timestamp: at(min), message: { role: 'user', content: 'Another Claude session sent a message: …' },
  origin: { kind: 'peer', from: 'uds:x', msg_id: msgId, name: from, body },
});
const bashLine = (min, description) => ({
  type: 'assistant', timestamp: at(min), message: { role: 'assistant', content: [{ type: 'tool_use', id: `b${min}`, name: 'Bash', input: { command: 'x', description } }] },
});

// 만든 임시 폴더는 모든 검사가 끝나면(실패해도) 지운다
const made = [];
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-act-'));
  made.push(d);
  return d;
}
const write = (dir, f, lines) => fs.writeFileSync(path.join(dir, f), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
const append = (dir, f, lines) => fs.appendFileSync(path.join(dir, f), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

test('저장소 경로로 대화 기록 폴더를 계산한다', () => {
  assert.strictEqual(transcriptDir('C:\\projects\\erp-project', 'H'), path.join('H', '.claude', 'projects', 'C--projects-erp-project'));
});

test('받는 쪽 대상 이름에서 [ref]를 뗀다', () => {
  assert.strictEqual(bareName('WY-pm [363ba2]'), 'WY-pm');
  assert.strictEqual(bareName('WY-pm'), 'WY-pm');
});

test('보낸 쪽과 받은 쪽 기록을 msg_id로 하나로 합친다', () => {
  const dir = tmpDir();
  write(dir, 'a.jsonl', [nameLine('WY-qa', 'a'), sendLine(1, 't1', 'WY-pm [abc]', '[결함] P1-09-09 입력 손실\n재현 3단계', '결함 보고'), sendResult(1, 't1', 'm1')]);
  write(dir, 'b.jsonl', [nameLine('WY-pm', 'b'), recvLine(2, 'WY-qa', 'm1', '[결함] P1-09-09 입력 손실\n재현 3단계')]);
  const r = new ActivityReader({ dir, now: () => T0 });
  assert.ok(r.poll());
  const feed = r.feed();
  assert.strictEqual(feed.length, 1);
  assert.deepStrictEqual([feed[0].from, feed[0].to, feed[0].at, feed[0].title], ['WY-qa', 'WY-pm', at(1), '결함 보고']);
  assert.strictEqual(r.unreadable, 0);
});

test('받은 쪽 기록만 있으면 요약은 본문 첫 줄이다', () => {
  const dir = tmpDir();
  write(dir, 'b.jsonl', [nameLine('WY-pm', 'b'), recvLine(2, 'WY-qa', 'm1', '\n[완료] 재검증 통과\n자세히')]);
  const r = new ActivityReader({ dir, now: () => T0 });
  r.poll();
  assert.strictEqual(r.feed()[0].title, '[완료] 재검증 통과');
});

test('새로 붙은 줄만 읽고, 덜 쓴 줄은 다음 주기에 마저 읽는다', () => {
  const dir = tmpDir();
  write(dir, 'b.jsonl', [nameLine('WY-pm', 'b')]);
  const r = new ActivityReader({ dir, now: () => T0 });
  r.poll();
  assert.strictEqual(r.poll(), false);
  const line = JSON.stringify(recvLine(3, 'WY-qa', 'm2', '안녕'));
  fs.appendFileSync(path.join(dir, 'b.jsonl'), line.slice(0, 20));
  r.poll();
  assert.strictEqual(r.feed().length, 0);
  fs.appendFileSync(path.join(dir, 'b.jsonl'), line.slice(20) + '\n');
  assert.ok(r.poll());
  assert.strictEqual(r.feed().length, 1);
  assert.strictEqual(r.unreadable, 0);
});

test('큰 파일은 끝부분만 읽고, 이름 줄은 앞에서 찾는다', () => {
  const dir = tmpDir();
  const filler = Array.from({ length: 300 }, (_, i) => ({ type: 'system', n: i, pad: 'x'.repeat(200) }));
  write(dir, 'b.jsonl', [nameLine('WY-pm', 'b'), recvLine(0, 'WY-qa', 'old', '옛 메시지'), ...filler, recvLine(5, 'WY-qa', 'new', '새 메시지')]);
  const r = new ActivityReader({ dir, now: () => Date.now() + 4 * 3600000, firstTail: 4096 }); // 최근 3시간 밖: 4KB만 읽음
  r.poll();
  const feed = r.feed();
  assert.deepStrictEqual(feed.map((m) => m.id), ['new']);
  assert.strictEqual(feed[0].to, 'WY-pm');
  assert.strictEqual(r.unreadable, 0, '잘린 첫 줄은 세지 않는다');
});

test('오래된 기록은 처음 열 때 건너뛴다', () => {
  const dir = tmpDir();
  write(dir, 'b.jsonl', [nameLine('WY-pm', 'b'), recvLine(0, 'WY-qa', 'm1', 'x')]);
  const r = new ActivityReader({ dir, now: () => Date.now() + 2 * 86400000 });
  r.poll();
  assert.strictEqual(r.feed().length, 0);
});

test('모르는 형식은 건너뛰고 읽을 수 없음으로 센다', () => {
  const dir = tmpDir();
  write(dir, 'b.jsonl', [nameLine('WY-pm', 'b'), '{깨진 줄', { type: 'user', origin: { kind: 'peer', name: 'WY-qa' } }, recvLine(1, 'WY-qa', 'm1', 'ok')]);
  const r = new ActivityReader({ dir, now: () => T0 });
  r.poll();
  assert.strictEqual(r.feed().length, 1);
  assert.strictEqual(r.unreadable, 2);
});

test('실패한 SendMessage는 피드에 넣지 않는다', () => {
  const dir = tmpDir();
  const fail = sendResult(1, 't1', 'm1');
  fail.toolUseResult = { success: false, message: 'no such agent' };
  write(dir, 'a.jsonl', [nameLine('WY-qa', 'a'), sendLine(1, 't1', 'WY-zz', 'x'), fail]);
  const r = new ActivityReader({ dir, now: () => T0 });
  r.poll();
  assert.strictEqual(r.feed().length, 0);
});

test('세션별 마지막 동작을 기록한다', () => {
  const dir = tmpDir();
  write(dir, 'a.jsonl', [nameLine('WY-qa', 'a'), bashLine(1, '재검증 테스트 실행'), sendLine(2, 't1', 'WY-pm', 'x'), sendResult(2, 't1', 'm1')]);
  const r = new ActivityReader({ dir, now: () => T0 });
  r.poll();
  assert.deepStrictEqual(r.lastActions().map((s) => [s.name, s.doing]), [['WY-qa', 'WY-pm에 메시지']]);
});

test('일한 구간은 90초 안으로 이어진 줄을 묶고, 같은 이름의 기록은 합친다', () => {
  const dir = tmpDir();
  const sec = (s) => new Date(T0 + s * 1000).toISOString();
  const work = (s) => ({ type: 'assistant', timestamp: sec(s), message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } });
  write(dir, 'a.jsonl', [nameLine('WY-qa', 'a'), work(0), work(60), work(120), work(600), recvLine(20, 'WY-pm', 'm1', 'x')]);
  write(dir, 'b.jsonl', [nameLine('WY-qa', 'b'), work(150)]);
  const r = new ActivityReader({ dir, now: () => T0 });
  r.poll();
  const qa = r.bandsSince(T0 - 1).find((x) => x.name === 'WY-qa');
  assert.deepStrictEqual(qa.bands, [[T0, T0 + 150000], [T0 + 600000, T0 + 600000]], '받은 메시지 자체는 일한 것으로 세지 않는다');
  assert.strictEqual(qa.from, T0, '읽은 기록의 시작');
  assert.deepStrictEqual(r.bandsSince(T0 + 300000).find((x) => x.name === 'WY-qa').bands, [[T0 + 600000, T0 + 600000]]);
});

test('단계와 작업 ID를 머리표·본문 앞부분에서 읽는다', () => {
  assert.strictEqual(stageOf({ body: '[결함] P1-09-09 …' }), 'bug');
  assert.strictEqual(stageOf({ body: 'WY-pm 지시: P1-09-09 결함 수정' }), 'order');
  assert.strictEqual(stageOf({ body: '[완료] 재검증 통과' }), 'done');
  assert.strictEqual(stageOf({ body: '커밋 5a7d531, 재검증 부탁' }), 'verify');
  assert.strictEqual(taskId({ body: '[결함] P1-09-09 입력 손실(P1-09 화면)' }), 'P1-09-09');
  assert.strictEqual(taskId({ summary: 'OPS-09 피드', body: '' }), 'OPS-09');
  assert.strictEqual(taskId({ body: '아무 ID 없음' }), null);
});

test('같은 작업 ID의 보고·수정·재검증은 한 묶음에 순서대로 들어간다', () => {
  const m = (min, from, to, body) => ({ id: `${min}`, from, to, at: at(min), body, summary: '', title: body.split('\n')[0] });
  const feed = [
    m(1, 'WY-qa', 'WY-pm', '[결함] P1-09-09 입력 손실'),
    m(2, 'WY-pm', 'WY-backend1', '지시: 다른 일'),
    m(3, 'WY-pm', 'WY-frontend2', 'WY-pm 지시: P1-09-09 결함 수정'),
    m(4, 'WY-frontend2', 'WY-commit', 'P1-09-09 커밋 요청'),
    m(5, 'WY-backend1', 'WY-pm', '[완료] 다른 일 끝'),
    m(6, 'WY-commit', 'WY-qa', 'P1-09-09 커밋 끝, 재검증 부탁'),
  ];
  const bs = bundle(feed);
  const bug = bs.find((b) => b.taskId === 'P1-09-09');
  assert.deepStrictEqual(bug.stages, ['bug', 'order', 'commit', 'verify']);
  assert.strictEqual(bug.state, 'run');
  assert.strictEqual(bs[0], bug, '최근에 움직인 묶음이 먼저');
  const other = bs.find((b) => !b.taskId);
  assert.deepStrictEqual(other.messages.map((x) => x.id), ['2', '5'], 'ID 없는 메시지는 같은 두 세션의 응답끼리 묶인다');
  assert.strictEqual(other.state, 'done');
});

test('ID 없는 대화는 [완료] 뒤에 새 묶음으로 시작한다', () => {
  const m = (min, body) => ({ id: `${min}`, from: 'WY-commit', to: 'WY-pm', at: at(min), body, summary: '', title: body });
  const bs = bundle([m(1, '커밋 요청 받음'), m(2, '[완료] 커밋 끝'), m(3, '[완료] 다른 커밋 끝')]);
  assert.deepStrictEqual(bs.map((b) => b.messages.map((x) => x.id)).sort(), [['1', '2'], ['3']]);
});
