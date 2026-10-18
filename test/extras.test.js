// 함께 까는 도구(extras.json·lib/extras.js): manifest 형식, plan(필수·끄기·needs), check·install(가짜 run), 이 PC의 실제 점검(읽기만)
//   node test/extras.test.js            가짜 명령만
//   node test/extras.test.js --real     + 이 PC에서 실제 점검(설치 명령은 부르지 않음)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rmTree } = require('../lib/fsx');
const { load, plan, check, install, projectPluginsOff } = require('../lib/extras');

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
for (const id of ['agent-browser', 'agent-browser-mcp', 'agent-reach', 'find-skills', 'graphify', 'claude-mem', 'prompts.chat']) assert.ok(ids.includes(id), `항목 ${id}`);
assert.throws(() => plan({ items: [{ id: 'a', needs: ['zz'], requiredFor: [], check: [], install: [] }] }), /needs zz/);

// 2. plan
const opsOf = (...gs) => ({ roles: gs.map((g) => ({ name: `AB-${g}`, group: g })) });
const by = (p) => Object.fromEntries(p.map((e) => [e.id, e]));
let p = by(plan({ ops: opsOf('pm', 'commit', 'backend') }));
assert.ok(!ids.includes('ecc'), 'ecc는 뺌(TOK-4, D-25 뒤 전역 삭제)');
assert.ok(!ids.includes('headroom'), 'headroom은 뺌(D-29)');
assert.ok(!p['claude-mem'].on && !p['prompts.chat'].on, 'claude-mem·prompts.chat 기본 꺼짐');
assert.ok(!p['agent-browser'].required && p['agent-browser'].on, 'qa·design·browser 없으면 선택이지만 기본 켜짐');
p = by(plan({ ops: { ...opsOf('qa'), extras: { off: ['agent-browser', 'claude-mem'] } } }));
assert.ok(p['agent-browser'].required && p['agent-browser'].on, 'qa가 있으면 agent-browser는 끌 수 없음');
assert.ok(!p['claude-mem'].on && !p['claude-mem'].required, 'ops.extras.off로 끔');
p = by(plan({ ops: opsOf('backend'), off: ['pipx', 'python', 'graphify'] }));
assert.ok(!p.graphify.on);
assert.ok(p.pipx.on && p.python.on, 'agent-reach가 켜져 있으면 pipx·python도 켬');
assert.deepStrictEqual(p.pipx.forcedBy, ['agent-reach']);
assert.deepStrictEqual(p.python.forcedBy, ['pipx']);
p = by(plan({ ops: opsOf('backend'), off: ['pipx', 'python', 'agent-reach', 'graphify'] }));
assert.ok(!p.pipx.on && !p.python.on, 'pipx를 부르는 것이 모두 꺼지면 pipx·python도 끔');

// 3. check·install(가짜 run, 가짜 홈)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-extras-'));
try {
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'find-skills'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'find-skills', 'SKILL.md'), '');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [home]: { mcpServers: { 'agent-browser': { command: 'agent-browser', args: ['mcp'] } } } } }));
  const calls = [];
  const have = new Set(['py -3 --version', 'py -3 -m pipx --version']);
  const failing = new Set();
  const run = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    // projectEnabled는 '프로젝트 settings가 켜는가'라 설정에 언급이 없어도 false다 — 끔(표준) 판정에 쓰면 안 됨
    if (line === 'claude plugin list --json') return { status: 0, stdout: JSON.stringify([{ id: 'prompts.chat@prompts.chat', enabled: true, projectEnabled: false }, { id: 'impeccable@impeccable', enabled: false, projectEnabled: false }]) };
    if (failing.has(cmd)) return { status: 1, stderr: 'boom\nlast line' };
    if (/--version$/.test(line)) return { status: have.has(line) ? 0 : 1 };
    return { status: 0 };
  };
  const st = Object.fromEntries(check({ run, home, plan: plan({ ops: opsOf('backend'), off: ['claude-mem'] }) }).map((r) => [r.id, r]));
  assert.strictEqual(st.python.state, 'ok');
  assert.strictEqual(st['find-skills'].state, 'ok', 'path 점검');
  assert.strictEqual(st['prompts.chat'].state, 'off', 'prompts.chat은 기본 꺼짐');
  assert.strictEqual(st.impeccable.state, 'missing', 'projectEnabled false·설정에 없음 → 끔(표준)이 아님');
  assert.match(st.impeccable.detail, /꺼져 있음/);
  assert.strictEqual(st['agent-browser'].state, 'missing');
  assert.strictEqual(st.graphify.state, 'missing');
  assert.strictEqual(st['agent-browser-mcp'].state, 'missing', '프로젝트 범위 등록은 사용자 범위로 치지 않음');
  assert.strictEqual(st['claude-mem'].state, 'off');
  assert.strictEqual(calls.filter((c) => c === 'claude plugin list --json').length, 1, 'plugin 목록은 한 번만 읽음');
  const pcOn = Object.fromEntries(check({ run, home }).map((r) => [r.id, r]))['prompts.chat'];
  assert.strictEqual(pcOn.state, 'ok', 'plugin 점검');
  assert.ok(!/프로젝트에서 끔/.test(pcOn.detail || ''), 'projectEnabled false만으로는 끔(표준)이 아님');

  // 프로젝트에서 끈 플러그인(enabledPlugins false)은 설치돼 있으면 ok(표준). local이 shared를 덮는다
  const proj = path.join(home, 'proj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'impeccable@impeccable': false, 'ecc@ecc': false } }));
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'ecc@ecc': true } }));
  assert.deepStrictEqual([...projectPluginsOff(proj)], ['impeccable@impeccable']);
  assert.deepStrictEqual([...projectPluginsOff(null)], []);
  const sp = Object.fromEntries(check({ run, home, project: proj }).map((r) => [r.id, r]));
  assert.strictEqual(sp.impeccable.state, 'ok');
  assert.match(sp.impeccable.detail, /프로젝트에서 끔/);
  // KI-07: 프로젝트가 있으면 plugin 목록을 그 폴더에서 읽는다(enabled는 실행 폴더의 프로젝트 settings를 따름)
  const cwds = [];
  check({ run: (cmd, args, o = {}) => (cmd === 'claude' && cwds.push(o.cwd), run(cmd, args)), home, project: proj });
  check({ run: (cmd, args, o = {}) => (cmd === 'claude' && cwds.push(o.cwd), run(cmd, args)), home });
  assert.deepStrictEqual(cwds, [proj, undefined], 'plugin list 실행 폴더');
  calls.length = 0;
  assert.strictEqual(install(['impeccable'], { run, home, project: proj })[0].state, 'ok', '프로젝트에서 끈 것은 다시 깔지 않음');
  assert.ok(!calls.some((c) => /plugin install/.test(c)));

  calls.length = 0;
  let res = Object.fromEntries(install(['python', 'graphify', 'agent-browser', 'claude-mem', 'prompts.chat'], { run, home }).map((r) => [r.id, r]));
  assert.strictEqual(res.python.state, 'ok', '이미 있으면 설치 안 함');
  assert.strictEqual(res['prompts.chat'].state, 'ok');
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
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'agent-browser': {} } }));
  assert.strictEqual(check({ run, home }).find((r) => r.id === 'agent-browser-mcp').state, 'ok', 'mcp 점검(사용자 범위)');
  calls.length = 0;
  res = Object.fromEntries(install(['agent-browser-mcp'], { run, home }).map((r) => [r.id, r]));
  assert.strictEqual(res['agent-browser-mcp'].state, 'ok', '이미 등록돼 있으면 건너뜀');
  assert.ok(!calls.some((c) => /mcp add/.test(c)));

  // 마켓플레이스 add 실패는 넘어가고, needs가 실패하면 뒤 항목은 건너뜀
  calls.length = 0;
  have.clear();
  failing.add('winget');
  res = Object.fromEntries(install(plan({ ops: opsOf('backend'), off: ['agent-reach', 'graphify', 'find-skills', 'agent-browser', 'agent-browser-mcp', 'ecc', 'impeccable', 'prompts.chat'] }), { run, home }).map((r) => [r.id, r]));
  assert.ok(!('pipx' in res) && !('python' in res), '부르는 항목이 없으면 python·pipx도 설치 안 함');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'agent-reach'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'agent-reach', 'SKILL.md'), '');
  calls.length = 0;
  res = Object.fromEntries(install(['python', 'pipx', 'agent-reach', 'graphify'], { run, home }).map((r) => [r.id, r]));
  assert.strictEqual(res.python.state, 'failed');
  assert.match(res.python.error, /winget install .*: last line/);
  assert.strictEqual(res.pipx.state, 'skipped');
  assert.strictEqual(res['agent-reach'].state, 'ok', 'agent-reach는 이미 있음(needs 실패와 무관)');
  assert.strictEqual(res.graphify.state, 'skipped', 'needs(pipx) 실패로 건너뜀');
  assert.ok(!calls.some((c) => /pipx install/.test(c)), '건너뛴 항목은 설치 명령을 부르지 않음');
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
