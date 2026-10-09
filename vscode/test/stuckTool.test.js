// 세션 멈춤 감지(stuckTool): 결과 없는 마지막 도구 호출 찾기, 기준 분(일반·빌드/테스트), 대상 세션, pm에 한 번 알림.
//   node vscode/test/stuckTool.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readOpenTool, stuckOf, notifyStuck, stuckThresholds } = require('../stuckTool');
const { withContext } = require('../agentsReader');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-stuck-'));
const T0 = Date.parse('2026-10-09T03:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const use = (id, name, input, min, extra) => JSON.stringify({ type: 'assistant', timestamp: at(min), ...extra, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, min) => JSON.stringify({ type: 'user', timestamp: at(min), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const write = (name, lines) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
};

const LOOP = 'until [ -f ~/.claude/wy-approvals/p/decisions/20261009-x.json ]; do sleep 5; done; cat ~/.claude/wy-approvals/p/decisions/20261009-x.json';

// 1. 결과 없는 마지막 도구 호출
{
  const f = write('open.jsonl', [use('t1', 'Read', { file_path: 'a.js' }, 0), result('t1', 0), use('t2', 'Bash', { command: LOOP }, 1)]);
  const o = readOpenTool(f);
  assert.deepStrictEqual([o.id, o.tool, o.long, o.since], ['t2', 'Bash', false, T0 + 60000], '마지막 호출');
  assert.ok(o.command.length <= 60 && o.command.startsWith('until [ -f'), '명령 앞부분만(60자)');

  assert.strictEqual(readOpenTool(write('closed.jsonl', [use('t1', 'Bash', { command: 'ls' }, 0), result('t1', 1)])), null, '결과가 있으면 없음');
  assert.strictEqual(readOpenTool(write('text.jsonl', [JSON.stringify({ type: 'assistant', timestamp: at(0), message: { content: [{ type: 'text', text: 'hi' }] } })])), null, '도구 호출 없음');
  assert.strictEqual(readOpenTool(path.join(tmp, 'none.jsonl')), null, '파일 없음');
  // 하위 에이전트 대화(사이드체인)의 도구 호출은 이 세션의 묶임이 아니다
  const side = write('side.jsonl', [use('t1', 'Bash', { command: 'ls' }, 0), result('t1', 0), use('s1', 'Bash', { command: 'sleep 999' }, 1, { isSidechain: true })]);
  assert.strictEqual(readOpenTool(side), null, '사이드체인 무시');
}

// 2. 원래 오래 걸리는 것: 빌드·테스트·설치·하위 에이전트
{
  const long = (input, name = 'Bash') => readOpenTool(write('l.jsonl', [use('t', name, input, 0)])).long;
  for (const cmd of ['./gradlew :app:compileJava --no-daemon', 'npm test', 'npm run test:unit', 'npx vitest run src', 'pytest -q', 'cargo test', 'docker compose up -d', 'npm ci']) {
    assert.strictEqual(long({ command: cmd }), true, cmd);
  }
  for (const cmd of [LOOP, 'git status', 'node vscode/test/a.test.js', 'npm view x']) assert.strictEqual(long({ command: cmd }), false, cmd);
  assert.strictEqual(long({ prompt: 'x', description: '조사' }, 'Agent'), true, '하위 에이전트');
}

// 3. 기준 분과 대상 세션
{
  assert.deepStrictEqual(stuckThresholds(null), { minutes: 10, longMinutes: 30 }, '기본');
  assert.deepStrictEqual(stuckThresholds({ stuck: { minutes: 5 } }), { minutes: 5, longMinutes: 30 }, '설정');
  const f = write('loop.jsonl', [use('toolu_0123456789abcdef', 'Bash', { command: LOOP }, 0)]);
  const row = { name: 'WY-commit', sessionId: 'aaaaaaaa-1111', kind: 'background', alive: true, view: 'working' };
  assert.strictEqual(stuckOf(row, f, null, T0 + 9 * 60000), null, '9분은 아직');
  const s = stuckOf(row, f, null, T0 + 12 * 60000 + 5000);
  assert.deepStrictEqual([s.minutes, s.tool, s.long, s.toolUseId], [12, 'Bash', false, 'toolu_0123456789abcdef'], '12분 멈춤 의심');
  assert.strictEqual(stuckOf({ ...row, kind: 'interactive' }, f, null, T0 + 60 * 60000), null, '대화형 세션은 사람이 보고 있다');
  assert.strictEqual(stuckOf({ ...row, view: 'permission' }, f, null, T0 + 60 * 60000), null, '권한 대기는 따로 보인다');
  assert.strictEqual(stuckOf({ ...row, view: 'input' }, f, null, T0 + 60 * 60000), null, '입력 대기');
  assert.strictEqual(stuckOf({ ...row, alive: false, view: 'off' }, f, null, T0 + 60 * 60000), null, '꺼진 세션');
  const build = write('build.jsonl', [use('t', 'Bash', { command: './gradlew build --no-daemon' }, 0)]);
  assert.strictEqual(stuckOf(row, build, null, T0 + 20 * 60000), null, '빌드 20분은 아직');
  assert.strictEqual(stuckOf(row, build, null, T0 + 31 * 60000).minutes, 31, '빌드 30분 넘음');

  // agentsReader가 대화 기록 경로로 붙인다
  const home = path.join(tmp, 'home');
  const root = 'C:\\proj\\x';
  const dir = path.join(home, '.claude', 'projects', 'C--proj-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(f, path.join(dir, 'aaaaaaaa-1111.jsonl'));
  const [r] = withContext([row], { root }, home, T0 + 15 * 60000);
  assert.strictEqual(r.stuck.minutes, 15, '세션 현황 줄에 stuck');
  assert.strictEqual(withContext([row], null, home, T0 + 15 * 60000)[0].stuck, null, '설정 없으면 없음');
}

// 4. pm에 한 번 알림: decisions.log 한 줄, 같은 도구 호출로는 한 번
{
  const root = path.join(tmp, 'approvals');
  const row = { name: 'WY-commit', sessionId: 'aaaaaaaa-1111', stuck: { minutes: 12, tool: 'Bash', command: 'until [ -f x ]', long: false, toolUseId: 'toolu_0123456789abcdef', since: at(0) } };
  const line = notifyStuck(root, row, 'WY-pm', new Date(T0 + 12 * 60000));
  assert.ok(line, '알림');
  const log = fs.readFileSync(path.join(root, 'decisions.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual([log[0].kind, log[0].decision, log[0].session, log[0].relatedSessions, log[0].minutes], ['stuck', 'stuck', 'WY-commit', ['WY-pm'], 12]);
  assert.ok(/WY-commit 세션이 도구 한 번\(Bash until \[ -f x \]\)에 12분째/.test(log[0].notice), log[0].notice);
  assert.strictEqual(notifyStuck(root, { ...row, stuck: { ...row.stuck, minutes: 13 } }, 'WY-pm'), null, '같은 호출은 다시 안 알림');
  assert.ok(notifyStuck(root, { ...row, stuck: { ...row.stuck, toolUseId: 'toolu_other' } }, 'WY-pm'), '다음 호출은 새로 알림');
  assert.strictEqual(notifyStuck(root, { ...row, stuck: { ...row.stuck, toolUseId: '../x' } }, 'WY-pm'), null, '이상한 id는 거부');
  assert.strictEqual(fs.readFileSync(path.join(root, 'decisions.log'), 'utf8').trim().split('\n').length, 2);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('stuckTool: 통과');
