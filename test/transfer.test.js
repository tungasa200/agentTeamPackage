// tools/wy-ops/lib/transfer.js 검사: 임시 홈 A에서 export → 다른 사용자 이름·프로젝트 경로(홈 B)로 import → 해시 비교,
// 비밀값 차단, 이 프로젝트 인수인계만, 옵션, 덮어쓰기 백업, 들여온 승인을 가드가 거부하는지,
// 전역 설정(CLAUDE.md·skills·agents·hooks·settings·MCP)과 토큰 자리표시·다시 입력할 항목
//   node tools/wy-ops/test/transfer.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmTree } = require('../lib/fsx');
const { exportState, importState, projectKey, unzip, PLACEHOLDER } = require('../lib/transfer');
const { zip } = require('../lib/zip');
const guard = require('../vscode/hooks/wy-approval-guard.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-transfer-'));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const put = (p, data) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const OPS = JSON.stringify({ commitRole: 'X-commit', secretsDir: '../my-app-secret', approvals: { namespace: 'ns', ttlMinutes: 60 } });
const P = { global: false }; // 1~7은 프로젝트 항목만 본다

try {
  // 원래 PC: 홈 A(사용자 alice), 프로젝트 A. 들여올 PC: 홈 B(한글 사용자 이름), 프로젝트 B(다른 경로)
  const homeA = path.join(tmp, 'Users', 'alice');
  const projA = path.join(tmp, 'projects', 'my-app');
  const homeB = path.join(tmp, 'Users', '홍길동');
  const projB = path.join(tmp, 'work', 'my-app');
  put(path.join(projA, '.claude', 'wy-ops.json'), OPS);
  put(path.join(projB, '.claude', 'wy-ops.json'), OPS);

  const cA = path.join(homeA, '.claude');
  const memA = path.join(cA, 'projects', projectKey(projA), 'memory');
  put(path.join(memA, 'MEMORY.md'), '- [규칙](rule.md) — 메모\n');
  put(path.join(memA, 'rule.md'), '# 규칙\n비밀값 폴더 위치만 적는다. token rotation 30초 유예.\n');
  put(path.join(memA, 'sub', 'deep.md'), '하위 폴더\n');
  put(path.join(memA, 'leak.md'), 'key: sk-ant-api03-' + 'a'.repeat(40) + '\n'); // 내용 검사로 막힘
  put(path.join(memA, '.env'), 'X=1\n'); // 이름 검사로 막힘
  put(path.join(memA, 'pw.md'), 'password = Hunter2Hunter2!!\n'); // 이름=값 모양으로 막힘
  const nsA = path.join(cA, 'wy-approvals', 'ns');
  const fresh = new Date().toISOString();
  put(path.join(nsA, 'requests', 'r1.json'), '{"id":"r1"}\n');
  put(path.join(nsA, 'decisions', 'r1.json'), JSON.stringify({ id: 'r1', decision: 'approved', kind: 'commit', command: 'git commit -m a', decidedAt: fresh }));
  put(path.join(nsA, 'decisions', 'r0.json'), JSON.stringify({ id: 'r0', decision: 'approved', kind: 'commit', command: 'git commit -m z', decidedAt: fresh }));
  put(path.join(nsA, 'used', 'r0.json'), '{"id":"r0"}\n');
  put(path.join(nsA, 'decisions.log'), '{"id":"r1"}\n');
  put(path.join(nsA, 'sessions', 's1.json'), '{}'); // 빠짐(살아 있는 세션 대장)
  put(path.join(cA, 'session-data', '2026-10-09-aaaa-session.tmp'), `# Session\n**Project:** my-app\n**Worktree:** ${projA}\n`);
  put(path.join(cA, 'session-data', '2026-10-09-bbbb-session.tmp'), `# Session\n**Worktree:** ${path.join(projA, '.claude', 'worktrees', 'x')}\n`);
  put(path.join(cA, 'session-data', '2026-10-09-cccc-session.tmp'), `# Session\n**Project:** other\n**Worktree:** ${path.join(tmp, 'other')}\n`);
  put(path.join(cA, 'session-data', 'token-usage.js'), '//\n');
  put(path.join(cA, 'projects', projectKey(projA), 'abc.jsonl'), '{"type":"user"}\n');
  const hookA = path.join(homeA, '.wy-tools', 'hooks', 'a.js');
  put(
    path.join(cA, 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'ecc@ecc': true }, extraKnownMarketplaces: { ecc: {} }, env: { SOME_API_KEY: 'abc123', MODE: 'fast' }, hooks: { Stop: [`node "${hookA}"`] }, model: 'opus' }, null, 2),
  );
  put(path.join(projA, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { x: [`node "${hookA}"`, `node "${hookA.replace(/\\/g, '/')}"`], cwd: projA } }, null, 2));

  // 1. export(기본: 대화는 빼고 settings.local은 넣음)
  const out = path.join(tmp, 'out', 'bundle.zip');
  const ex = exportState({ project: projA, out, home: homeA, include: P });
  const names = ex.files.map((f) => f.name).sort();
  assert.deepStrictEqual(names, [
    'approvals/decisions.log',
    'approvals/decisions/r0.json',
    'approvals/decisions/r1.json',
    'approvals/requests/r1.json',
    'approvals/used/r0.json',
    'handoff/2026-10-09-aaaa-session.tmp',
    'handoff/2026-10-09-bbbb-session.tmp',
    'memory/MEMORY.md',
    'memory/rule.md',
    'memory/sub/deep.md',
    'settingsLocal/settings.local.json',
  ]);
  assert.deepStrictEqual(ex.skipped.map((s) => s.rel).sort(), ['.env', 'leak.md', 'pw.md'], '비밀값 3개 차단');
  assert.ok(ex.skipped.every((s) => /비밀값/.test(s.reason) && !s.reason.includes('Hunter2')), '이유에 값이 없음');
  assert.deepStrictEqual(ex.plugins, { enabledPlugins: { 'ecc@ecc': true }, marketplaces: ['ecc'] });
  const items = unzip(fs.readFileSync(out));
  assert.ok(items.has('manifest.json'));
  assert.ok(![...items.values()].some((b) => b.toString().includes('sk-ant-') || b.toString().includes('Hunter2')), 'zip 어디에도 비밀값 없음');

  // 2. 미리 보기(dryRun)는 아무것도 쓰지 않는다
  const dry = importState({ project: projB, zip: out, home: homeB, dryRun: true, include: P });
  assert.ok(dry.files.every((f) => f.status === 'new'));
  assert.strictEqual(dry.markedUsed, 1);
  assert.ok(!fs.existsSync(path.join(homeB, '.claude')), 'dryRun은 쓰지 않음');

  // 3. import → 새 경로에 놓이고 해시가 같다, 결정 r1에 used 표시
  const im = importState({ project: projB, zip: out, home: homeB, include: P });
  assert.strictEqual(im.files.length, 11);
  assert.strictEqual(im.backupDir, null);
  const memB = path.join(homeB, '.claude', 'projects', projectKey(projB), 'memory');
  // settings.local.json은 경로를 바꿔 쓰므로 해시 대신 6에서 내용을 본다
  for (const f of ex.files.filter((x) => x.kind !== 'settingsLocal')) {
    const t = im.files.find((x) => x.kind === f.kind && x.rel === f.rel).target;
    assert.strictEqual(sha(t), f.sha256, `해시 같음: ${f.name}`);
  }
  assert.ok(im.files.find((f) => f.rel === 'MEMORY.md').target.startsWith(memB));
  const nsB = path.join(homeB, '.claude', 'wy-approvals', 'ns');
  assert.ok(!fs.existsSync(path.join(nsB, 'sessions')));
  assert.strictEqual(im.markedUsed, 1);
  assert.strictEqual(readJson(path.join(nsB, 'used', 'r1.json')).imported, true);
  assert.strictEqual(fs.readFileSync(path.join(nsB, 'used', 'r0.json'), 'utf8'), '{"id":"r0"}\n', '원래 used는 그대로');
  assert.deepStrictEqual(im.reenter, [], '공통 할 일(비밀값 폴더 복사 등)은 install.js가 출력하므로 reenter에 없음');
  assert.strictEqual(im.source.secretsDir, '../my-app-secret', '비밀값 폴더 위치(값 아님)는 manifest에 남김');

  // 4. 들여온 결정은 모두 used 표시가 있다. 가드: 원래 PC에서는 승인으로 통하는 결정이, 들여온 PC에서는 used 표시 때문에 거부된다
  for (const f of fs.readdirSync(path.join(nsB, 'decisions'))) assert.ok(fs.existsSync(path.join(nsB, 'used', f)), `used 표시: ${f}`);
  const gin = (cwd) => ({ tool_name: 'Bash', tool_input: { command: 'git commit -m a' }, agent_type: 'X-commit', cwd, session_id: 's' });
  assert.strictEqual(guard.evaluate(gin(projB), nsB).decision, 'deny', '들여온 승인은 쓸 수 없음');
  assert.strictEqual(guard.evaluate(gin(projA), nsA).decision, 'allow', '대조: 원래 PC에서는 통과');

  // 5. 다시 import → 모두 same. 한 파일을 바꿔 두면 overwrite + 백업
  put(path.join(memB, 'rule.md'), '새 PC에서 바뀐 내용\n');
  const again = importState({ project: projB, zip: out, home: homeB, include: P });
  assert.deepStrictEqual(again.files.filter((f) => f.status !== 'same').map((f) => [f.rel, f.status]), [['rule.md', 'overwrite']]);
  assert.strictEqual(fs.readFileSync(path.join(again.backupDir, 'memory', 'rule.md'), 'utf8'), '새 PC에서 바뀐 내용\n');
  assert.strictEqual(sha(path.join(memB, 'rule.md')), ex.files.find((f) => f.rel === 'rule.md').sha256);

  // 6. settings.local.json은 홈·프로젝트 경로가 바뀌어 놓인다(끌 수 있음). 대화는 켤 때만
  const sl = readJson(path.join(projB, '.claude', 'settings.local.json'));
  const hookB = path.join(homeB, '.wy-tools', 'hooks', 'a.js');
  assert.deepStrictEqual(sl.hooks.x, [`node "${hookB}"`, `node "${hookB.replace(/\\/g, '/')}"`]);
  assert.strictEqual(sl.hooks.cwd, projB);
  assert.ok(!exportState({ project: projA, out: path.join(tmp, 'out', 'nosl.zip'), home: homeA, include: { ...P, settingsLocal: false } }).files.some((f) => f.kind === 'settingsLocal'));
  const out2 = path.join(tmp, 'out', 'full.zip');
  const ex2 = exportState({ project: projA, out: out2, home: homeA, include: { ...P, transcripts: true } });
  assert.ok(ex2.files.some((f) => f.name === 'transcripts/abc.jsonl'));
  const off = importState({ project: projB, zip: out2, home: homeB, dryRun: true, include: P });
  assert.ok(off.skipped.some((s) => s.kind === 'transcripts' && s.reason === '옵션으로 끔'), '들일 때 옵션이 꺼져 있으면 넣지 않음');
  importState({ project: projB, zip: out2, home: homeB, include: { ...P, transcripts: true } });
  assert.ok(fs.existsSync(path.join(homeB, '.claude', 'projects', projectKey(projB), 'abc.jsonl')));

  // 7. 손상·경로 탈출 묶음은 거부
  const m = JSON.parse(items.get('manifest.json').toString());
  const evil = { ...m, files: [{ name: 'memory/x', kind: 'memory', rel: '../../../evil.txt', sha256: crypto.createHash('sha256').update('x').digest('hex') }] };
  put(path.join(tmp, 'evil.zip'), zip([{ name: 'manifest.json', data: JSON.stringify(evil) }, { name: 'memory/x', data: 'x' }]));
  assert.throws(() => importState({ project: projB, zip: path.join(tmp, 'evil.zip'), home: homeB }), /벗어납니다/);
  const bad = { ...m, files: [{ ...m.files[0], sha256: '0'.repeat(64) }] };
  put(path.join(tmp, 'bad.zip'), zip([{ name: 'manifest.json', data: JSON.stringify(bad) }, { name: m.files[0].name, data: items.get(m.files[0].name) }]));
  assert.throws(() => importState({ project: projB, zip: path.join(tmp, 'bad.zip'), home: homeB, dryRun: true }), /손상/);

  // 8. 전역 설정(카드 1020): 홈 A의 전역 항목 → 홈 C(이미 Claude를 쓴 PC: ~/.claude.json에 계정 상태와 같은 MCP 서버의 실제 토큰이 있음)
  put(path.join(cA, 'CLAUDE.md'), '# 전역 지침\n');
  put(path.join(cA, 'skills', 'tool-a', 'SKILL.md'), '---\nname: tool-a\n---\n');
  put(path.join(cA, 'skills', 'tool-a', 'run.py'), 'print("ok")\n');
  put(path.join(cA, 'skills', 'tool-a', 'node_modules', 'x', 'index.js'), '//\n'); // 빠짐
  put(path.join(cA, 'skills', 'tool-b', 'call.sh'), 'curl -H "Authorization: Bearer ' + 'b'.repeat(30) + '" x\n'); // 비밀값으로 빠짐
  put(path.join(cA, 'agents', 'helper.md'), '---\nname: helper\n---\n');
  put(path.join(cA, 'hooks', 'lib', 'h.js'), 'module.exports = 1;\n');
  put(path.join(cA, '.credentials.json'), '{"t":"x"}'); // 넣지 않음
  put(path.join(cA, 'history.jsonl'), '{}\n'); // 넣지 않음
  const homeAfwd = path.resolve(homeA).replace(/\\/g, '/');
  put(
    path.join(homeA, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'a@example.com' },
      numStartups: 9,
      mcpServers: { s1: { type: 'stdio', command: 'node', args: [`${homeAfwd}/mcp/s1.js`], env: { S1_TOKEN: 'real-a-token' } }, s2: { type: 'http', url: 'https://x.example', headers: { Authorization: 'Bearer zzz' } } },
      projects: { [homeAfwd]: { allowedTools: [], mcpServers: { p1: { type: 'stdio', command: 'p1', args: [], env: {} } } }, 'C:/elsewhere': { allowedTools: [] } },
    }),
  );
  const out3 = path.join(tmp, 'out', 'global.zip');
  const ex3 = exportState({ project: projA, out: out3, home: homeA });
  const g = ex3.files.filter((f) => ['claudeMd', 'skills', 'agents', 'hooks', 'globalSettings', 'mcp'].includes(f.kind)).map((f) => f.name).sort();
  assert.deepStrictEqual(g, ['agents/helper.md', 'claudeMd/CLAUDE.md', 'globalSettings/settings.json', 'hooks/lib/h.js', 'mcp/mcpServers.json', 'skills/tool-a/SKILL.md', 'skills/tool-a/run.py']);
  assert.ok(ex3.skipped.some((s) => s.kind === 'skills' && s.rel === 'tool-b/call.sh' && /Bearer/.test(s.reason)), '스킬 스크립트의 비밀값 보고');
  const z3 = unzip(fs.readFileSync(out3));
  const all3 = [...z3.values()].map((b) => b.toString()).join('\n');
  for (const s of ['real-a-token', 'Bearer zzz', 'abc123', 'a@example.com', 'numStartups', 'C:/elsewhere']) assert.ok(!all3.includes(s), `묶음에 없음: ${s}`);
  const mcpZ = JSON.parse(z3.get('mcp/mcpServers.json').toString());
  assert.strictEqual(mcpZ.user.s1.env.S1_TOKEN, PLACEHOLDER);
  assert.strictEqual(mcpZ.user.s2.headers.Authorization, PLACEHOLDER);
  assert.strictEqual(JSON.parse(z3.get('globalSettings/settings.json').toString()).env.SOME_API_KEY, PLACEHOLDER);
  assert.strictEqual(JSON.parse(z3.get('globalSettings/settings.json').toString()).model, 'opus', '비밀값 아닌 값은 그대로');

  const homeC = path.join(tmp, 'Users', 'carol');
  const projC = path.join(tmp, 'dev', 'my-app');
  put(path.join(projC, '.claude', 'wy-ops.json'), OPS);
  put(path.join(homeC, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'c@example.com' }, mcpServers: { s1: { env: { S1_TOKEN: 'real-c-token' } }, keep: { command: 'k' } } }));
  const im3 = importState({ project: projC, zip: out3, home: homeC });
  const cC = path.join(homeC, '.claude');
  assert.strictEqual(fs.readFileSync(path.join(cC, 'CLAUDE.md'), 'utf8'), '# 전역 지침\n');
  assert.ok(fs.existsSync(path.join(cC, 'skills', 'tool-a', 'run.py')) && fs.existsSync(path.join(cC, 'agents', 'helper.md')) && fs.existsSync(path.join(cC, 'hooks', 'lib', 'h.js')));
  assert.ok(!fs.existsSync(path.join(cC, '.credentials.json')) && !fs.existsSync(path.join(cC, 'history.jsonl')));
  const cj = readJson(path.join(homeC, '.claude.json'));
  const homeCfwd = path.resolve(homeC).replace(/\\/g, '/');
  assert.strictEqual(cj.oauthAccount.emailAddress, 'c@example.com', '계정 상태는 그대로');
  assert.strictEqual(cj.mcpServers.keep.command, 'k', '대상에만 있던 서버는 그대로');
  assert.strictEqual(cj.mcpServers.s1.env.S1_TOKEN, 'real-c-token', '대상의 실제 토큰을 살림');
  assert.deepStrictEqual(cj.mcpServers.s1.args, [`${homeCfwd}/mcp/s1.js`], 'MCP 경로가 새 홈으로');
  assert.strictEqual(cj.mcpServers.s2.headers.Authorization, PLACEHOLDER);
  assert.ok(cj.projects[homeCfwd].mcpServers.p1, '프로젝트별 MCP는 새 홈 경로 키로');
  assert.ok(im3.backupDir && fs.existsSync(path.join(im3.backupDir, 'mcp', '.claude.json')), '~/.claude.json 백업');
  const gs = readJson(path.join(cC, 'settings.json'));
  assert.strictEqual(gs.env.SOME_API_KEY, PLACEHOLDER);
  assert.deepStrictEqual(gs.hooks.Stop, [`node "${path.join(homeC, '.wy-tools', 'hooks', 'a.js')}"`], '전역 settings 경로도 바뀜');
  const re = im3.reenter.map((x) => `${x.where} ${x.key}`);
  assert.ok(re.includes('~/.claude.json mcpServers s2.headers.Authorization'));
  assert.ok(re.includes('~/.claude/settings.json env.SOME_API_KEY'));
  assert.ok(re.includes('~/.claude/settings.json env.MODE'), 'env 값은 모두 다시 입력');
  assert.ok(!re.some((x) => x.includes('S1_TOKEN')), '살린 토큰은 목록에 없음');
  assert.ok(!im3.files.some((f) => f.kind === 'skills' && f.rel === 'tool-b/call.sh'));

  console.log('transfer.test.js: 통과');
} finally {
  rmTree(tmp);
}
