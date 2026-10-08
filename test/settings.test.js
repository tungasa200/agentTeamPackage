// 훅 명령에서 스크립트 경로 읽기(settings.hookScriptInfo·scriptOf): 공백·한글이 든 홈에서도 경로를 통째로 읽고,
// 확실히 읽지 못하면 unknown으로 알린다(WY-commit 보고 결함: 공백 기준으로 잘려 doctor·cleanup-legacy가 오판).
//   node tools/wy-ops/test/settings.test.js
const assert = require('assert');
const { hookScriptInfo, scriptOf, splitCommand, plan } = require('../lib/settings');

const HOME = 'C:/Users/홍 길동';
const cmd = (command) => ({ type: 'command', command });
const info = (h) => hookScriptInfo(h);

// 1. args 배열이 우선(setup이 쓰는 형식)
assert.deepStrictEqual(info({ type: 'command', command: 'node', args: [`${HOME}/.wy-tools/wy-ops/current/vscode/hooks/a.js`] }), { script: `${HOME}/.wy-tools/wy-ops/current/vscode/hooks/a.js`, unknown: false });

// 2. 따옴표 안의 공백·한글 경로는 통째로
assert.strictEqual(scriptOf(cmd(`node "${HOME}/.wy-tools/vscode-dashboard/hooks/wy-approval-guard.js"`)), `${HOME}/.wy-tools/vscode-dashboard/hooks/wy-approval-guard.js`, '큰따옴표');
assert.strictEqual(scriptOf(cmd(`node '${HOME}/x/hook.js'`)), `${HOME}/x/hook.js`, '작은따옴표');
assert.strictEqual(scriptOf(cmd('node "C:\\Users\\홍 길동\\hooks\\b.js" --flag')), 'C:/Users/홍 길동/hooks/b.js', '역슬래시·뒤 인자');
assert.strictEqual(scriptOf(cmd('node C:/Users/me/.wy-tools/hooks/c.js')), 'C:/Users/me/.wy-tools/hooks/c.js', '공백 없는 따옴표 없는 경로');
assert.strictEqual(scriptOf(cmd('node ~/.wy-tools/hooks/d.js')), '~/.wy-tools/hooks/d.js', '~ 경로');

// 3. 확실히 읽지 못하면 unknown(따옴표 없이 공백이 든 경로, 짝 안 맞는 따옴표, 상대 경로)
for (const c of [`node ${HOME}/.wy-tools/hooks/e.js`, `node "${HOME}/hooks/f.js`, 'node hooks/g.js']) {
  assert.deepStrictEqual(info(cmd(c)), { script: null, unknown: true }, `판단 불가: ${c}`);
  assert.strictEqual(scriptOf(cmd(c)), null, 'scriptOf는 null');
}

// 4. 스크립트 훅이 아니면 unknown이 아님
assert.deepStrictEqual(info(cmd('echo hello')), { script: null, unknown: false });
assert.deepStrictEqual(info(null), { script: null, unknown: false });

// 5. 조각내기
assert.deepStrictEqual(splitCommand('node "a b/c.js" \'d e\' f'), ['node', 'a b/c.js', 'd e', 'f']);
assert.deepStrictEqual(splitCommand('node ""'), ['node', ''], '빈 따옴표도 조각');
assert.strictEqual(splitCommand('node "a'), null, '짝 안 맞음');

// 6. plan: 따옴표로 감싼 옛 경로 훅을 찾아 새 경로로 바꾼다(중복으로 더하지 않음)
{
  const NEW = `${HOME}/.wy-tools/wy-ops/current/vscode/hooks`;
  const cur = { hooks: { SessionStart: [{ hooks: [cmd(`node "${HOME}/.wy-tools/vscode-dashboard/hooks/wy-session-start.js"`)] }] } };
  const { next, changes } = plan(cur, NEW);
  assert.strictEqual(next.hooks.SessionStart.length, 1, '그룹을 더하지 않음');
  assert.ok(changes.some((c) => c.type === 'hook-update' && c.event === 'SessionStart'), '옛 경로를 새 경로로');
  assert.deepStrictEqual(next.hooks.SessionStart[0].hooks[0].args, [`${NEW}/wy-session-start.js`]);
}

console.log('settings 검사 통과');
