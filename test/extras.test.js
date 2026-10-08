// 함께 까는 도구(extras.json·lib/extras.js): manifest 형식, plan(필수·끄기·needs), check·install(가짜 run), 이 PC의 실제 점검(읽기만)
//   node test/extras.test.js            가짜 명령만
//   node test/extras.test.js --real     + 이 PC에서 실제 점검(설치 명령은 부르지 않음)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rmTree } = require('../lib/fsx');
const { load, plan, check, install } = require('../lib/extras');

const roles = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'roles.json'), 'utf8'));
const GROUPS = new Set(['rotation', ...roles.groups.map((g) => g.id)]);
const KINDS = ['winget', 'pip', 'npm-global', 'skill', 'mcp', 'pipx', 'plugin'];

// 1. 형식
const items = load();
const ids = items.map((x) => x.id);
assert.strictEqual(new Set(ids).size, ids.length, 'id 중복');
for (const it of items) {
  assert.ok(KINDS.includes(it.kind), `${it.id}: kind ${it.kind}`);
  assert.ok(it.label && it.source, `${it.id}: label·source`);
  assert.ok(Array.isArray(it.check) && it.check.length, `${it.id}: check`);
  assert.ok(Array.isArray(it.install) && it.install.length && it.install.every((s) => Array.isArray(s) && s.length && s.every((a) => typeof a === 'string')), `${it.id}: install [[cmd, ...args]]`);
  for (const g of it.requiredFor) assert.ok(GROUPS.has(g), `${it.id}: 모르는 그룹 ${g}`);
  for (const n of it.needs || []) assert.ok(ids.indexOf(n) >= 0 && ids.indexOf(n) < ids.indexOf(it.id), `${it.id}: needs ${n}은 앞에 있어야 함`);
}
for (const id of ['agent-browser', 'agent-browser-mcp', 'agent-reach', 'find-skills', 'graphify', 'headroom', 'ecc', 'claude-mem', 'prompts.chat']) assert.ok(ids.includes(id), `항목 ${id}`);
assert.throws(() => plan({ items: [{ id: 'a', needs: ['zz'], requiredFor: [], check: [], install: [] }] }), /needs zz/);

// 2. plan
const opsOf = (...gs) => ({ roles: gs.map((g) => ({ name: `AB-${g}`, group: g })) });
const by = (p) => Object.fromEntries(p.map((e) => [e.id, e]));
let p = by(plan({ ops: opsOf('pm', 'commit', 'backend') }));
assert.ok(p.ecc.required && p.ecc.on, 'ecc는 늘 필수(rotation)');
assert.ok(!p['agent-browser'].required && p['agent-browser'].on, 'qa·design·browser 없으면 선택이지만 기본 켜짐');
p = by(plan({ ops: { ...opsOf('qa'), extras: { off: ['agent-browser', 'claude-mem'] } } }));
assert.ok(p['agent-browser'].required && p['agent-browser'].on, 'qa가 있으면 agent-browser는 끌 수 없음');
assert.ok(!p['claude-mem'].on && !p['claude-mem'].required, 'ops.extras.off로 끔');
p = by(plan({ ops: opsOf('backend'), off: ['pipx', 'python', 'agent-reach', 'graphify'] }));
assert.ok(!p['agent-reach'].on && !p.graphify.on);
assert.ok(p.pipx.on && p.python.on, 'headroom이 켜져 있으면 pipx·python도 켬');
assert.deepStrictEqual(p.pipx.forcedBy, ['headroom']);
assert.deepStrictEqual(p.python.forcedBy, ['pipx']);
p = by(plan({ ops: opsOf('backend'), off: ['pipx', 'python', 'agent-reach', 'graphify', 'headroom'] }));
assert.ok(!p.pipx.on && !p.python.on, 'pipx를 부르는 것이 모두 꺼지면 pipx·python도 끔');

// 3. check·install(가짜 run, 가짜 홈)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-extras-'));
try {
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'find-skills'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'find-skills', 'SKILL.md'), '');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { headroom: { command: 'x' } }, projects: { [home]: { mcpServers: { 'agent-browser': { command: 'agent-browser', args: ['mcp'] } } } } }));
  const calls = [];
  const have = new Set(['py -3 --version', 'py -3 -m pipx --version']);
  const failing = new Set();
  const run = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    if (line === 'claude plugin list --json') return { status: 0, stdout: JSON.stringify([{ id: 'ecc@ecc', enabled: true }, { id: 'impeccable@impeccable', enabled: false }]) };
    if (failing.has(cmd)) return { status: 1, stderr: 'boom\nlast line' };
    if (/--version$/.test(line)) return { status: have.has(line) ? 0 : 1 };
    return { status: 0 };
  };
  const st = Object.fromEntries(check({ run, home, plan: plan({ ops: opsOf('backend'), off: ['claude-mem'] }) }).map((r) => [r.id, r]));
  assert.strictEqual(st.python.state, 'ok');
  assert.strictEqual(st['find-skills'].state, 'ok', 'path 점검');
  assert.strictEqual(st.headroom.state, 'ok', 'mcp 점검');
  assert.strictEqual(st.ecc.state, 'ok', 'plugin 점검');
  assert.strictEqual(st.impeccable.state, 'missing');
  assert.match(st.impeccable.detail, /꺼져 있음/);
  assert.strictEqual(st['agent-browser'].state, 'missing');
  assert.strictEqual(st.graphify.state, 'missing');
  assert.strictEqual(st['agent-browser-mcp'].state, 'missing', '프로젝트 범위 등록은 사용자 범위로 치지 않음');
  assert.strictEqual(st['claude-mem'].state, 'off');
  assert.strictEqual(calls.filter((c) => c === 'claude plugin list --json').length, 1, 'plugin 목록은 한 번만 읽음');

  calls.length = 0;
  let res = Object.fromEntries(install(['python', 'graphify', 'agent-browser', 'claude-mem', 'ecc'], { run, home }).map((r) => [r.id, r]));
  assert.strictEqual(res.python.state, 'ok', '이미 있으면 설치 안 함');
  assert.strictEqual(res.ecc.state, 'ok');
  assert.strictEqual(res.graphify.state, 'installed');
  assert.ok(calls.includes('py -3 -m pipx install graphifyy'));
  assert.ok(calls.includes(`${path.join(home, '.local/bin/graphify.exe')} install --platform windows`), '~는 홈으로');
  assert.ok(calls.includes('npm install -g agent-browser') && calls.includes('agent-browser install'));
  assert.ok(calls.includes('claude plugin install claude-mem@thedotmack --scope user'));
  assert.ok(!calls.some((c) => /winget/.test(c)), 'python은 있으므로 winget 안 부름');

  // agent-browser가 있으면 MCP 등록만 한다(npm·브라우저 다시 받지 않음)
  calls.length = 0;
  have.add('agent-browser --version');
  res = Object.fromEntries(install(['agent-browser', 'agent-browser-mcp'], { run, home }).map((r) => [r.id, r]));
  assert.strictEqual(res['agent-browser'].state, 'ok');
  assert.strictEqual(res['agent-browser-mcp'].state, 'installed');
  assert.ok(calls.includes('claude mcp add --scope user agent-browser -- agent-browser mcp'));
  assert.ok(!calls.some((c) => /npm install|agent-browser install/.test(c)), 'MCP만 없을 때 재설치 안 함');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { headroom: {}, 'agent-browser': {} } }));
  calls.length = 0;
  res = Object.fromEntries(install(['agent-browser-mcp'], { run, home }).map((r) => [r.id, r]));
  assert.strictEqual(res['agent-browser-mcp'].state, 'ok', '이미 등록돼 있으면 건너뜀');
  assert.ok(!calls.some((c) => /mcp add/.test(c)));

  // 마켓플레이스 add 실패는 넘어가고, needs가 실패하면 뒤 항목은 건너뜀
  calls.length = 0;
  have.clear();
  failing.add('winget');
  res = Object.fromEntries(install(plan({ ops: opsOf('backend'), off: ['agent-reach', 'graphify', 'headroom', 'find-skills', 'agent-browser', 'agent-browser-mcp', 'ecc', 'impeccable', 'prompts.chat'] }), { run, home }).map((r) => [r.id, r]));
  assert.ok(!('pipx' in res) && !('python' in res), '부르는 항목이 없으면 python·pipx도 설치 안 함');
  res = Object.fromEntries(install(['python', 'pipx', 'headroom'], { run, home }).map((r) => [r.id, r]));
  assert.strictEqual(res.python.state, 'failed');
  assert.match(res.python.error, /winget install .*: last line/);
  assert.strictEqual(res.pipx.state, 'skipped');
  assert.strictEqual(res.headroom.state, 'ok', 'headroom은 MCP가 이미 등록돼 있음');
} finally {
  rmTree(home);
}

// 4. 이 PC에서 실제 점검(읽기만, 설치 명령은 부르지 않음)
if (process.argv.includes('--real')) {
  const SHIMS = ['claude', 'npm', 'npx', 'agent-browser'];
  const realRun = (cmd, args) => {
    const installCmd = items.some((it) => it.install.some((s) => s[0] === cmd && s.slice(1).join(' ') === args.join(' ')));
    assert.ok(!installCmd || /--version$/.test(args.join(' ')), `설치 명령을 부르려 함: ${cmd} ${args.join(' ')}`);
    const opts = { encoding: 'utf8', windowsHide: true, timeout: 60000 };
    if (process.platform === 'win32' && SHIMS.includes(cmd)) return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].join(' ')}"`], { ...opts, windowsVerbatimArguments: true });
    return spawnSync(cmd, args, opts);
  };
  for (const r of check({ run: realRun })) console.log(`  ${r.state.padEnd(7)} ${r.id}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log('extras.test: 통과');
