// doctor 점검(PACKAGING-PLAN 4장) 검사: 임시 홈·저장소와 가짜 실행기(run)로 항목마다 통과·주의·실패를 만든다. 실제 홈은 쓰지 않는다.
//   node tools/wy-ops/test/doctor.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const { rmTree, copyTree } = require('../lib/fsx');
const path = require('path');
const doctor = require('../lib/doctor');
const { writeTodo } = require('../lib/todo');
const store = require('../vscode/approvalStore');

const PKG = path.join(__dirname, '..');
const template = JSON.parse(fs.readFileSync(path.join(PKG, 'templates', 'settings.hooks.json'), 'utf8'));
const plugins = JSON.parse(fs.readFileSync(path.join(PKG, 'plugins.json'), 'utf8')).plugins;
let pkgVersion = null;
try {
  pkgVersion = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
} catch {
  // R2 전에는 패키지 버전 파일이 없다
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-doctor-'));
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const json = (p, v) => write(p, JSON.stringify(v, null, 2));
const HEAD = 'abc1234';

// 모두 통과하는 PC 하나를 만든다
const NON_PLUGIN = require('../lib/extras').load().filter((x) => x.kind !== 'plugin').map((x) => x.id);

function makePc(name, { home: homeName = 'home' } = {}) {
  const root = path.join(base, name);
  const home = path.join(root, homeName);
  const repo = path.join(root, 'repo');
  const toolsDir = path.join(home, '.wy-tools', 'wy-ops');
  const hooksDir = path.join(toolsDir, 'current', 'vscode', 'hooks');
  for (const t of template.hooks) write(path.join(hooksDir, t.script), '// hook\n');
  json(path.join(toolsDir, 'current', 'deployed.json'), { version: pkgVersion || '0.1.0', commit: `${HEAD}def`, stubHash: 'h1' });
  const settingsFile = path.join(repo, '.claude', 'settings.local.json');
  const hooks = {};
  for (const t of template.hooks) {
    hooks[t.event] = hooks[t.event] || [];
    hooks[t.event].push({ ...(t.matcher ? { matcher: t.matcher } : {}), hooks: [{ type: 'command', command: `node "${path.join(hooksDir, t.script).replace(/\\/g, '/')}"`, timeout: t.timeout }] });
  }
  json(settingsFile, { permissions: { deny: template.deny, allow: ['WebSearch'] }, hooks });
  // 플러그인 밖의 함께 까는 도구는 기본 시험에서 꺼 둔다(따로 시험)
  json(path.join(repo, '.claude', 'wy-ops.json'), { project: 'p', pmRole: 'X-pm', commitRole: 'X-commit', roles: [{ name: 'X-pm' }, { name: 'X-commit', agent: true }], approvals: { namespace: 'p' }, extras: { off: NON_PLUGIN } });
  write(path.join(repo, '.claude', 'agents', 'X-commit.md'), '# X-commit\n경로는 ~/.claude/wy-approvals\n');
  write(path.join(repo, '.gitignore'), ['node_modules', '.claude/settings.local.json', '.claude/wy-ops.local.json', '.claude/*.bak-*'].join('\n') + '\n');
  const approvalsRoot = path.join(home, '.claude', 'wy-approvals', 'p');
  fs.mkdirSync(approvalsRoot, { recursive: true });
  const stubDir = path.join(home, '.vscode', 'extensions', 'wy-ops.wy-ops-0.1.0');
  json(path.join(stubDir, 'package.json'), { name: 'wy-ops', wyOpsStubHash: 'h1' });
  json(path.join(home, '.vscode', 'extensions', 'extensions.json'), [{ identifier: { id: 'wy-ops.wy-ops' }, version: '0.1.0', location: { $mid: 1, path: '/' + stubDir.replace(/\\/g, '/'), scheme: 'file' }, relativeLocation: 'wy-ops.wy-ops-0.1.0' }]);
  const state = {
    extensions: ['wy-ops.wy-ops@0.1.0', 'ms-python.python@1.0.0'],
    plugins: plugins.map((p) => ({ id: p.id, version: p.version, enabled: true })),
    genAgents: 0,
    gh: 0,
    calls: [],
  };
  const run = (cmd, args = []) => {
    state.calls.push([cmd, ...args].join(' '));
    const ok = (stdout = '') => ({ status: 0, stdout });
    if (cmd === 'git' && args[0] === '--version') return ok('git version 2.50.0\n');
    if (cmd === 'git' && args.includes('rev-parse')) return ok(HEAD + '\n');
    if (cmd === 'code' && args[0] === '--version') return ok('1.140.0\n');
    if (cmd === 'code' && args[0] === '--list-extensions') return ok(state.extensions.join('\n') + '\n');
    if (cmd === 'claude' && args[0] === '--version') return ok('2.1.292 (Claude Code)\n');
    if (cmd === 'claude' && args[0] === 'plugin') return ok(JSON.stringify(state.plugins));
    if (cmd === 'powershell') return ok('5.1.19041.1\n');
    if (cmd === 'node' && args.includes('--check') && String(args[0]).endsWith('gen-agents.js')) return { status: state.genAgents, stdout: state.genAgents ? 'X-commit.md가 다름\n' : '' };
    if (cmd === 'node' && args[0] === '--check') return ok();
    if (cmd === 'gh') return { status: state.gh, stdout: '' };
    if (cmd === 'where') return ok('C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code\n');
    return { status: null, stdout: '' };
  };
  const opts = { repoRoot: repo, home, toolsDir, approvalsRoot, settingsFile, run };
  return { root, home, repo, toolsDir, hooksDir, settingsFile, approvalsRoot, stubDir, state, opts };
}

// 함께 까는 도구: 꺼짐은 실패가 아님, 필수가 없으면 실패, 선택이 없으면 주의, 끈 플러그인은 '꺼짐'
function extrasCases() {
  const pc = makePc('extras');
  const cfg = path.join(pc.repo, '.claude', 'wy-ops.json');
  const ops0 = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  let r = byId(doctor.checkAll(pc.opts)).extras;
  assert.ok(r.level === 'ok' && r.detail.includes('꺼짐'), JSON.stringify(r));
  // qa 역할이 있으면 agent-browser는 필수: 없으면 실패
  json(cfg, { ...ops0, roles: [...ops0.roles, { name: 'X-qa', agent: true, group: 'qa' }], extras: { off: NON_PLUGIN.filter((id) => !/^agent-browser/.test(id)) } });
  r = byId(doctor.checkAll(pc.opts)).extras;
  assert.ok(r.level === 'fail' && r.detail.includes('agent-browser'), JSON.stringify(r));
  // 역할 필수가 아니면(선택) 없을 때 주의
  json(cfg, { ...ops0, extras: { off: NON_PLUGIN.filter((id) => !/^agent-browser/.test(id)) } });
  assert.strictEqual(byId(doctor.checkAll(pc.opts)).extras.level, 'warn', '선택 항목 없음은 주의');
  // 끈 선택 플러그인은 '꺼짐'(실패 아님)
  json(cfg, { ...ops0, extras: { off: [...NON_PLUGIN, 'claude-mem'] } });
  pc.state.plugins = pc.state.plugins.filter((p) => p.id !== 'claude-mem@thedotmack');
  r = byId(doctor.checkAll(pc.opts)).plugins;
  assert.ok(r.level === 'ok' && r.detail.includes('claude-mem@thedotmack 꺼짐(설정)'), JSON.stringify(r));
  // 켜 둔(기본) 플러그인이 없으면 실패
  json(cfg, ops0);
  assert.strictEqual(byId(doctor.checkAll(pc.opts)).plugins.level, 'fail', '켜진 플러그인 없음은 실패');
}

const byId = (results) => Object.fromEntries(results.map((r) => [r.id, r]));
const levels = (results) => Object.fromEntries(results.map((r) => [r.id, r.level]));

// 파일 트리의 모든 파일 이름·크기·수정 시각(doctor가 아무것도 쓰지 않는지 보려고)
function snapshot(dir) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.readdirSync(p).sort().forEach((n) => walk(path.join(p, n)));
    else out.push(`${p}|${st.size}|${st.mtimeMs}`);
  };
  walk(dir);
  return out.join('\n');
}

try {
  // 1. 모두 통과, 그리고 읽기만 한다
  {
    const pc = makePc('ok');
    const before = snapshot(pc.root);
    const results = doctor.checkAll(pc.opts);
    // 임시 폴더(TEMP) 자체에 공백·한글이 있으면 doctor가 의도대로 '경로 주의'를 띄운다 — 그때만 그 한 줄은 허용
    const oddTemp = /\s|[^\x00-\x7f]/.test(base);
    const bad = results.filter((r) => r.level !== 'ok' && !(oddTemp && r.id === 'paths-warn' && r.level === 'warn'));
    assert.deepStrictEqual(bad, [], '모두 통과');
    assert.strictEqual(snapshot(pc.root), before, '어떤 파일도 쓰지 않음');
    assert.ok(results.every((r) => r.id && r.title && r.detail !== undefined && 'fix' in r), '결과 형식');
    assert.ok(byId(results).ledger.detail.includes('새로 시작'), 'wy-ops 확장이 있으면 원장 새로 시작 안내');
    assert.strictEqual(byId(results).extension.detail, `wy-ops.wy-ops(껍데기) · 확장 코드 0.1.0 · 패키지 ${pkgVersion || '0.1.0'}`, '껍데기 버전과 패키지 버전을 나눠 보임');
  }

  // 2. 훅: 파일 없음·current 밖(옛 설치본)·설정에 없음 → 실패
  {
    const pc = makePc('hooks');
    rmTree(path.join(pc.hooksDir, 'wy-session-start.js'));
    const s = JSON.parse(fs.readFileSync(pc.settingsFile, 'utf8'));
    const old = path.join(pc.home, '.wy-tools', 'vscode-dashboard', 'hooks', 'wy-approval-guard.js');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, '');
    s.hooks.PreToolUse[0].hooks[0].command = `node "${old.replace(/\\/g, '/')}"`;
    delete s.hooks.PermissionDenied;
    json(pc.settingsFile, s);
    const h = byId(doctor.checkAll(pc.opts)).hooks;
    assert.strictEqual(h.level, 'fail');
    assert.ok(h.detail.includes('wy-session-start.js: 파일 없음'), '파일 없음');
    assert.ok(h.detail.includes('current 밖'), '옛 경로');
    assert.ok(h.detail.includes('PermissionDenied wy-permission.js: 없음'), '설정에 없음');
    assert.ok(h.fix.includes('install.ps1" setup'), '고치기');
  }

  // 3. deny 줄 빠짐, settings 깨짐
  {
    const pc = makePc('deny');
    const s = JSON.parse(fs.readFileSync(pc.settingsFile, 'utf8'));
    s.permissions.deny = s.permissions.deny.slice(1);
    json(pc.settingsFile, s);
    assert.strictEqual(byId(doctor.checkAll(pc.opts)).deny.level, 'fail', 'deny 빠짐');
    write(pc.settingsFile, '{ 깨진');
    const r = byId(doctor.checkAll(pc.opts));
    assert.deepStrictEqual([r.hooks.level, r.deny.level], ['fail', 'fail'], '깨진 settings');
  }

  // 4. 설치본: 없음·커밋 다름
  {
    const pc = makePc('install');
    json(path.join(pc.toolsDir, 'current', 'deployed.json'), { version: pkgVersion || '0.1.0', commit: 'zzz9999', stubHash: 'h1' });
    const r = byId(doctor.checkAll(pc.opts)).install;
    assert.strictEqual(r.level, 'fail');
    assert.ok(r.detail.includes('HEAD abc1234') && r.fix.endsWith('install.ps1" deploy'), '커밋 다름');
    // 패키지 저장소 clone에서 설치: 그 clone의 HEAD와 비교
    const clone = path.join(pc.root, 'pkgclone');
    const dep = path.join(pc.toolsDir, 'current', 'deployed.json');
    json(dep, { version: '0.7.0', commit: 'aaa1111', stubHash: 'h1', source: { kind: 'head', repo: clone, rel: '' } });
    const runHead = (h) => (cmd, args) => (cmd === 'git' && args[0] === '-C' && args[1] === clone ? (h ? { status: 0, stdout: `${h}\n` } : { status: 128, stdout: '' }) : pc.opts.run(cmd, args));
    let s = byId(doctor.checkAll({ ...pc.opts, run: runHead('aaa1111') })).install;
    assert.ok(s.level === 'ok' && s.detail.includes('pkgclone'), JSON.stringify(s));
    s = byId(doctor.checkAll({ ...pc.opts, run: runHead('bbb2222') })).install;
    assert.ok(s.level === 'fail' && s.detail.includes('bbb2222'), 'clone이 앞서면(pull 뒤 deploy 안 함) 실패');
    assert.strictEqual(byId(doctor.checkAll({ ...pc.opts, run: runHead(null) })).install.level, 'warn', '원본을 못 읽으면 주의');
    // 개발 연결 중이면 주의
    json(dep, { version: '0.7.2', commit: 'dev', dev: true, stubHash: 'h1', source: { kind: 'dev', repo: clone, rel: '' } });
    s = byId(doctor.checkAll(pc.opts)).install;
    assert.ok(s.level === 'warn' && s.detail.includes('개발 연결 중'), JSON.stringify(s));
    // 버전 고정: 프로젝트 wyOpsVersion과 설치본 버전
    const opsFile = path.join(pc.repo, '.claude', 'wy-ops.json');
    const ops0 = JSON.parse(fs.readFileSync(opsFile, 'utf8'));
    assert.strictEqual(byId(doctor.checkAll(pc.opts))['version-pin'].level, 'ok', '고정 없으면 통과');
    json(opsFile, { ...ops0, wyOpsVersion: '0.7.2' });
    assert.strictEqual(byId(doctor.checkAll(pc.opts))['version-pin'].level, 'ok', '같으면 통과');
    json(opsFile, { ...ops0, wyOpsVersion: '0.7.0' });
    s = byId(doctor.checkAll(pc.opts))['version-pin'];
    assert.ok(s.level === 'warn' && s.detail.includes('0.7.0') && s.detail.includes('0.7.2'), JSON.stringify(s));
    json(opsFile, ops0);
    rmTree(path.join(pc.toolsDir, 'current'));
    assert.ok(byId(doctor.checkAll(pc.opts)).install.detail.includes('없음'), '설치본 없음');
  }

  // 5. 확장: 껍데기 없음·contributes 해시 다름·옛 확장 남음
  {
    const pc = makePc('ext');
    pc.state.extensions = ['erp-project.erp-session-dashboard@0.5.0'];
    let r = byId(doctor.checkAll(pc.opts)).extension;
    assert.ok(r.level === 'fail' && r.detail.includes('옛 erp-project.erp-session-dashboard'), '껍데기 없음');
    pc.state.extensions = ['wy-ops.wy-ops@0.1.0', 'erp-project.erp-session-dashboard@0.5.0'];
    r = byId(doctor.checkAll(pc.opts)).extension;
    assert.ok(r.level === 'warn' && r.fix.includes('--uninstall-extension erp-project.erp-session-dashboard'), '옛 확장 경고');
    json(path.join(pc.stubDir, 'package.json'), { name: 'wy-ops', wyOpsStubHash: 'h0' });
    r = byId(doctor.checkAll(pc.opts)).extension;
    assert.ok(r.level === 'fail' && r.detail.includes('contributes'), '해시 다름');
  }

  // 6. 플러그인: 필수 없음은 실패, version은 최소 버전(새 것은 통과, 낮으면 주의), 선택 없음은 통과
  {
    const pc = makePc('plugins');
    pc.state.plugins = pc.state.plugins.filter((p) => !p.id.startsWith('prompts.chat'));
    const pcfg = path.join(pc.repo, '.claude', 'wy-ops.json');
    const pops = JSON.parse(fs.readFileSync(pcfg, 'utf8'));
    json(pcfg, { ...pops, extras: { off: [...pops.extras.off, 'prompts.chat'] } });
    assert.strictEqual(byId(doctor.checkAll(pc.opts)).plugins.level, 'ok', '끈 선택 플러그인은 없어도 통과');
    const ecc = pc.state.plugins.find((p) => p.id === 'ecc@ecc');
    for (const newer of ['9.9.9', '2.2.10', '2.3.0']) {
      ecc.version = newer;
      assert.strictEqual(byId(doctor.checkAll(pc.opts)).plugins.level, 'ok', `최소보다 새 버전 ${newer}은 통과`);
    }
    ecc.version = '2.1.9';
    let r = byId(doctor.checkAll(pc.opts)).plugins;
    assert.ok(r.level === 'warn' && r.detail.includes('ecc@ecc 2.1.9(최소 2.2.2)'), '최소보다 낮으면 주의');
    ecc.version = 'unknown';
    assert.strictEqual(byId(doctor.checkAll(pc.opts)).plugins.level, 'ok', '읽을 수 없는 버전은 낮다고 보지 않음');
    pc.state.plugins = pc.state.plugins.filter((p) => p.id !== 'impeccable@impeccable');
    r = byId(doctor.checkAll(pc.opts)).plugins;
    assert.ok(r.level === 'fail' && r.fix.includes('claude plugin install impeccable@impeccable'), '필수 없음은 실패');
  }

  // 7. 설정·역할 파일, 개인 경로, .gitignore
  {
    const pc = makePc('config');
    pc.state.genAgents = 1;
    assert.ok(byId(doctor.checkAll(pc.opts)).config.fix.includes(' gen'), '역할 파일 다름');
    pc.state.genAgents = 0;
    write(path.join(pc.repo, '.claude', 'ops', 'roles', 'X-qa.md'), `캡처는 ${pc.home.replace(/\\/g, '/')}/shots에\n`);
    const p = byId(doctor.checkAll(pc.opts))['paths-personal'];
    assert.ok(p.level === 'fail' && p.detail.includes('.claude/ops/roles/X-qa.md:1'), '개인 경로');
    write(path.join(pc.repo, '.gitignore'), 'node_modules\n/.claude/settings.local.json\n');
    const g = byId(doctor.checkAll(pc.opts)).gitignore;
    assert.ok(g.level === 'fail' && g.detail.includes('.claude/wy-ops.local.json') && !g.detail.includes('settings.local.json,'), '.gitignore 빠진 줄(앞 / 허용)');
    json(path.join(pc.repo, '.claude', 'wy-ops.json'), { project: 'p', pmRole: 'nobody', roles: [{ name: 'X-pm' }], approvals: { namespace: '../x' } });
    const c = byId(doctor.checkAll(pc.opts)).config;
    assert.ok(c.level === 'fail' && c.detail.includes('pmRole') && c.detail.includes('namespace'), 'wy-ops.json 형식');
  }

  // 8. 손일은 할 일 카드 형식으로(lib/todo.js가 그대로 받고 승인 센터가 형식 오류로 보지 않음)
  {
    const pc = makePc('todo');
    json(path.join(pc.repo, '.claude', 'wy-ops.json'), { ...JSON.parse(fs.readFileSync(path.join(pc.repo, '.claude', 'wy-ops.json'), 'utf8')), secretsDir: '~/no-such-secret' });
    pc.state.gh = 1;
    const r = byId(doctor.checkAll(pc.opts));
    assert.strictEqual(r.secrets.level, 'warn', '비밀값 폴더 없음은 주의');
    assert.strictEqual(r['login-github'].level, 'warn', 'gh 로그인 안 됨은 주의');
    for (const item of [r.secrets.todo, r['login-github'].todo]) {
      const { id, written } = writeTodo(pc.approvalsRoot, item);
      assert.ok(written, '할 일 카드 씀');
      const req = store.readRequest(path.join(pc.approvalsRoot, 'requests', `${id}.json`), id);
      assert.ok(!req.broken, `형식 오류 아님: ${req.broken}`);
    }
    fs.mkdirSync(path.join(pc.home, 'no-such-secret'));
    assert.strictEqual(byId(doctor.checkAll(pc.opts)).secrets.level, 'ok', '비밀값 폴더 있으면 통과');
  }

  // 8-1. 비밀값 폴더: 저장소 기준 상대 경로(커밋 파일에 PC 경로 없음), PC별 wy-ops.local.json이 덮어씀
  {
    const pc = makePc('secrets');
    const opsFile = path.join(pc.repo, '.claude', 'wy-ops.json');
    json(opsFile, { ...JSON.parse(fs.readFileSync(opsFile, 'utf8')), secretsDir: '../worklog-secret' });
    let r = byId(doctor.checkAll(pc.opts)).secrets;
    assert.ok(r.level === 'warn' && r.detail.includes(`${path.join(pc.root, 'worklog-secret').replace(/\\/g, '/')} 없음`), '상대 경로는 저장소 루트 기준');
    fs.mkdirSync(path.join(pc.root, 'worklog-secret'));
    write(path.join(pc.root, 'worklog-secret', 'secret.txt'), '읽으면 안 됨');
    r = byId(doctor.checkAll(pc.opts)).secrets;
    assert.ok(r.level === 'ok' && !r.detail.includes('읽으면 안 됨'), '있으면 통과, 내용은 읽지 않음');
    const elsewhere = path.join(pc.root, 'other-place', 'secret');
    json(path.join(pc.repo, '.claude', 'wy-ops.local.json'), { secretsDir: elsewhere });
    r = byId(doctor.checkAll(pc.opts)).secrets;
    assert.ok(r.level === 'warn' && r.detail.includes('other-place'), 'local이 덮어씀');
    fs.mkdirSync(elsewhere, { recursive: true });
    assert.strictEqual(byId(doctor.checkAll(pc.opts)).secrets.level, 'ok', 'local 경로에 있으면 통과');
    assert.strictEqual(byId(doctor.checkAll(pc.opts))['paths-personal'].level, 'ok', '상대 경로는 개인 경로 점검에 걸리지 않음');
    // 선택 설정 secretsKeys: 키 이름만 확인, 값은 출력하지 않음
    write(path.join(elsewhere, 'keys.txt'), 'API_TOKEN=값비밀1\nDB_PASSWORD: 값비밀2\n');
    json(path.join(pc.repo, '.claude', 'wy-ops.local.json'), { secretsDir: elsewhere, secretsKeys: ['API_TOKEN', 'DB_PASSWORD'] });
    r = byId(doctor.checkAll(pc.opts)).secrets;
    assert.ok(r.level === 'ok' && r.detail.includes('키 2개') && !r.detail.includes('값비밀'), JSON.stringify(r));
    json(path.join(pc.repo, '.claude', 'wy-ops.local.json'), { secretsDir: elsewhere, secretsKeys: ['API_TOKEN', 'MAIL_KEY'] });
    r = byId(doctor.checkAll(pc.opts)).secrets;
    assert.ok(r.level === 'warn' && r.detail.includes('MAIL_KEY') && !r.detail.includes('API_TOKEN') && !JSON.stringify(r).includes('값비밀'), JSON.stringify(r));
  }

  // 8-2. 확장 폴더 지정(setup --extensions-dir과 같은 값): 그 폴더의 extensions.json을 읽고 code에도 붙인다
  {
    const pc = makePc('extdir');
    const custom = path.join(pc.root, 'ext-dir');
    fs.renameSync(path.join(pc.home, '.vscode', 'extensions'), custom);
    const list = JSON.parse(fs.readFileSync(path.join(custom, 'extensions.json'), 'utf8'));
    list[0].location.path = '/' + path.join(custom, 'wy-ops.wy-ops-0.1.0').replace(/\\/g, '/');
    json(path.join(custom, 'extensions.json'), list);
    assert.strictEqual(byId(doctor.checkAll(pc.opts)).extension.level, 'fail', '지정하지 않으면 기본 폴더에서 못 찾음');
    pc.state.calls = [];
    assert.strictEqual(byId(doctor.checkAll({ ...pc.opts, extensionsDir: custom })).extension.level, 'ok', '지정한 폴더에서 찾음');
    assert.ok(pc.state.calls.some((c) => c.startsWith('code --list-extensions') && c.includes(`--extensions-dir ${custom}`)), 'code에도 --extensions-dir');
  }

  // 8-3. 설치본 위치 기본값은 deploy.toolsDir()(WY_TOOLS_DIR가 있으면 그 아래 wy-ops)
  {
    const pc = makePc('toolsenv');
    const envDir = path.join(pc.root, 'tools-env');
    copyTree(pc.toolsDir, path.join(envDir, 'wy-ops'));
    const saved = process.env.WY_TOOLS_DIR;
    process.env.WY_TOOLS_DIR = envDir;
    try {
      const { toolsDir, ...rest } = pc.opts;
      const r = byId(doctor.checkAll(rest)).install;
      assert.strictEqual(r.level, 'ok', `WY_TOOLS_DIR/wy-ops를 봄: ${r.detail}`);
      assert.strictEqual(doctor.defaults({ repoRoot: pc.repo }).toolsDir, path.join(envDir, 'wy-ops'));
    } finally {
      if (saved === undefined) delete process.env.WY_TOOLS_DIR;
      else process.env.WY_TOOLS_DIR = saved;
    }
  }

  // 8-4. 한글·공백 홈: 따옴표로 감싼 훅 명령의 경로를 통째로 읽어 통과, 따옴표 없이 공백이 든 경로는 '판단 불가'로 실패(WY-commit 보고 결함)
  {
    const pc = makePc('kospace', { home: '사용자 홈 2' });
    assert.strictEqual(byId(doctor.checkAll(pc.opts)).hooks.level, 'ok', `한글·공백 홈의 따옴표 경로: ${byId(doctor.checkAll(pc.opts)).hooks.detail}`);
    const s = JSON.parse(fs.readFileSync(pc.settingsFile, 'utf8'));
    s.hooks.SessionStart[0].hooks[0].command = `node ${path.join(pc.hooksDir, 'wy-session-start.js').replace(/\\/g, '/')}`;
    json(pc.settingsFile, s);
    const h = byId(doctor.checkAll(pc.opts)).hooks;
    assert.ok(h.level === 'fail' && h.detail.includes('SessionStart wy-session-start.js: 판단 불가'), `따옴표 없는 공백 경로는 판단 불가: ${h.detail}`);
  }

  // 9. 한글·공백 홈은 주의하고 훅을 문법 검사만 한다(실행하지 않음)
  {
    const pc = makePc('korean', { home: '사용자 홈' });
    const r = byId(doctor.checkAll(pc.opts))['paths-warn'];
    assert.ok(r.level === 'warn' && r.detail.includes('문법 검사 통과'), '경로 주의');
    assert.ok(pc.state.calls.some((c) => c.startsWith('node --check') && c.includes('wy-approval-guard.js')), 'node --check로만 확인');
  }

  // 10. 실행기가 예외를 던져도 나머지 항목은 나온다, 표는 실패·주의가 먼저
  // 스택 개발 도구: 고른 스택의 tools만, 없으면 주의 + 설치 안내
  {
    const pc = makePc('stacktools');
    assert.strictEqual(byId(doctor.checkAll(pc.opts))['stack-tools'].level, 'ok', 'tools 없으면 통과');
    const cfg = path.join(pc.repo, '.claude', 'wy-ops.json');
    const ops = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    json(cfg, { ...ops, stack: 'java-gradle', tools: [{ cmd: 'java', label: 'JDK', install: 'winget install JDK' }, { cmd: 'node', label: 'Node.js', install: 'winget install Node' }] });
    const run = (cmd, args) => (cmd === 'where' && args[0] === 'java' ? { status: 1, stdout: '' } : pc.opts.run(cmd, args));
    const r = byId(doctor.checkAll({ ...pc.opts, run }))['stack-tools'];
    assert.ok(r.level === 'warn' && r.detail.includes('JDK') && !r.detail.includes('Node.js') && r.fix.includes('winget install JDK'), JSON.stringify(r));
    assert.strictEqual(byId(doctor.checkAll(pc.opts))['stack-tools'].level, 'ok', '다 있으면 통과');
    // WindowsApps에만 있는 스토어 별칭: --version이 실패하면 없음, 성공하면 있음
    json(cfg, { ...ops, stack: 'python', tools: [{ cmd: 'python', label: 'Python', install: 'winget install Python' }] });
    const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe';
    const store = (ver) => (cmd, args) => (cmd === 'where' && args[0] === 'python' ? { status: 0, stdout: `${alias}\r\n` } : cmd === alias ? { status: ver, stdout: '' } : pc.opts.run(cmd, args));
    assert.strictEqual(byId(doctor.checkAll({ ...pc.opts, run: store(9009) }))['stack-tools'].level, 'warn', '설치 안 된 스토어 별칭은 없음');
    assert.strictEqual(byId(doctor.checkAll({ ...pc.opts, run: store(0) }))['stack-tools'].level, 'ok', '스토어 설치본(--version 성공)은 있음');
    // anyOf: 여럿 중 하나만 있으면 통과, 모두 없으면 주의
    json(cfg, { ...ops, stack: 'cpp', tools: [{ anyOf: ['cl', 'clang', 'g++'], label: 'C++ 컴파일러', install: 'LLVM 설치' }] });
    const only = (have) => (cmd, args) => (cmd === 'where' && ['cl', 'clang', 'g++'].includes(args[0]) ? { status: args[0] === have ? 0 : 1, stdout: have ? `C:\\x\\${have}.exe\n` : '' } : pc.opts.run(cmd, args));
    assert.strictEqual(byId(doctor.checkAll({ ...pc.opts, run: only('g++') }))['stack-tools'].level, 'ok', 'g++만 있어도 통과');
    const none = byId(doctor.checkAll({ ...pc.opts, run: only(null) }))['stack-tools'];
    assert.ok(none.level === 'warn' && none.detail.includes('C++ 컴파일러') && none.fix.includes('LLVM 설치'), JSON.stringify(none));
    json(cfg, ops);
  }

  // 고치기 안내의 install.ps1 경로는 실제 설치본 위치를 따른다(WY_TOOLS_DIR 등)
  {
    const pc = makePc('toolsdir');
    const toolsDir = path.join(pc.root, 'custom-tools', 'wy-ops');
    const fixes = doctor.checkAll({ ...pc.opts, toolsDir }).map((r) => r.fix).filter((f) => f && f.includes('install.ps1'));
    assert.ok(fixes.length && fixes.every((f) => f.includes(path.join(toolsDir, 'current', 'install.ps1')) && !f.includes('$env:USERPROFILE')), fixes.join('\n'));
  }

  {
    const pc = makePc('throw');
    const run = (cmd, args) => {
      if (cmd === 'code') throw new Error('터짐');
      return pc.opts.run(cmd, args);
    };
    const results = doctor.checkAll({ ...pc.opts, run });
    assert.ok(results.length >= 14, '항목 수 유지');
    assert.ok(results.some((r) => r.title === '점검 오류' && r.detail.includes('터짐')), '예외는 실패 한 줄로');
    const text = doctor.format(results);
    assert.ok(text.indexOf('[실패]') < text.indexOf('[ 통과 ]'), '실패가 먼저');
    assert.ok(/실패 \d+ · 주의 \d+ · 통과 \d+/.test(text), '요약 줄');
  }

  extrasCases();
  console.log('doctor 검사 통과');
} finally {
  rmTree(base);
}
