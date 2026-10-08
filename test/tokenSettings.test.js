// 토큰 절감 2차 설정 적용(lib/tokenSettings.js): env 병합·훅 병합, 다른 키 보존, 두 번째는 바꿀 것 없음
//   node tools/wy-ops/test/tokenSettings.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, planEnv } = require('../lib/tokenSettings');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-tok-'));
try {
  const proj = path.join(tmp, 'proj');
  const hooks = path.join(tmp, 'hooks').replace(/\\/g, '/');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.mkdirSync(hooks);
  const shared = path.join(proj, '.claude', 'settings.json');
  const local = path.join(proj, '.claude', 'settings.local.json');
  fs.writeFileSync(shared, JSON.stringify({ worktree: { bgIsolation: 'none' }, env: { FOO: '1' } }));
  // 훅 파일이 설치본에 없으면 아무것도 쓰지 않는다
  assert.throws(() => run('apply', proj, hooks), /wy-context-size\.js/);
  assert.ok(!fs.existsSync(local));
  fs.writeFileSync(path.join(hooks, 'wy-context-size.js'), '');
  assert.ok(run('plan', proj, hooks).some((l) => l.includes('+ env CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000')));
  assert.ok(!fs.existsSync(local), 'plan은 쓰지 않음');
  run('apply', proj, hooks);
  const s = JSON.parse(fs.readFileSync(shared, 'utf8'));
  assert.deepStrictEqual(s, { worktree: { bgIsolation: 'none' }, env: { FOO: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } }, '다른 키 보존');
  const l = JSON.parse(fs.readFileSync(local, 'utf8'));
  assert.deepStrictEqual(l.hooks.Stop[0].hooks[0].args, [`${hooks}/wy-context-size.js`]);
  assert.ok(run('apply', proj, hooks).every((x) => x.endsWith('바꿀 것 없음')), '두 번째는 바꿀 것 없음');
  assert.strictEqual(planEnv({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100' } }).changes[0], '~ env CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000');
  console.log('tokenSettings 검사 통과');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
