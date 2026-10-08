#!/usr/bin/env node
// WY Ops 설치 명령 본체(OPS-10). install.ps1이 그대로 넘겨 부른다.
//   deploy [--dev]                  HEAD를 버전 폴더에 설치하고 current를 바꾼다(lib/deploy.js). --dev는 current를 작업 사본에 바로 연결
//   global   [--skip-plugins]       deploy + 껍데기 확장 + 필수 플러그인 + NEW-PC.md 체크리스트. 어느 프로젝트도 건드리지 않는다
//   setup    [--project <폴더>]     global + 이 프로젝트 settings.local.json 병합(차이 → 확인) + 승인 폴더 + doctor + 남은 일 할 일 카드
//   doctor   [--json]               점검(lib/doctor.js, 읽기만)
//   rollback [<버전>]               current를 이전 버전으로
//   cleanup-legacy                  옛 승인 위치·옛 설치본 목록 → 확인 → 지움(lib/legacy.js)
//   init --name <이름> --prefix <XX-> [--stack <id>] [--verify-<build|test|...> <명령>] [--roles a,b] [--count backend=2,frontend=2]
//        [--area "<역할>=<디렉터리>;…"] [--no-principles] [--project <폴더, 기본 현재 폴더>]
//                                   새 프로젝트(OPS-10-2): 설정·역할 원본·생성 파일·.gitignore(lib/init.js) + settings 병합 + 승인 폴더 + doctor,
//                                   CLAUDE.md에 넣을 절을 출력만 한다. 그 PC에 global(또는 setup)을 먼저 해 둔다
//   update [--project <폴더>] [--dry-run]  deploy + 생성 파일 다시 만들기(사람이 고친 것은 덮지 않고 차이만, lib/update.js)
//   gen [--project <폴더>]                 .claude/ops 원본을 고친 뒤 역할 파일·pm-ops 스킬 다시 만들기(lock도 맞춤)
//   export [--out <zip>] [--no-settings]   개인 이전 묶음(git 밖 상태: 메모리·승인 이력·인수인계·settings.local.json)을 zip으로(lib/transfer.js)
//   import <zip> [--dry-run] [--no-settings] 묶음 들여오기. 덮어쓸 파일이 있으면 목록을 보여 주고 확인(원래 파일은 백업), 들여온 승인은 '사용됨' 표시
//   restore <zip> [--project <폴더>]        새 PC 한 번에: global → 프로젝트 clone(묶음의 원격·브랜치) → import(전역 설정 포함) → setup(doctor) → 남은 할 일
// 필수 환경(Node·Git·gh·VS Code·Claude Code) 확인·설치는 install.ps1이 이 파일을 부르기 전에 한다(--yes, --skip-install).
// 공통: --yes(확인 없이 진행), --extensions-dir <폴더>(code에 넘김, 시험용). 결정 파일(decisions/·used/)은 쓰지 않는다(OPS-10-3).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG = path.resolve(__dirname, '..');
const OLD_EXT = 'erp-project.erp-session-dashboard'; // 옛 확장 id 정리용(패키지화 전 설치본에서 바꿀 때)
const STUB_EXT = 'wy-ops.wy-ops';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : null);
const say = (s = '') => process.stdout.write(s + '\n');

// code·claude·gh는 Windows에서 .cmd 래퍼라 cmd.exe로 부르고, 나머지(where 등)는 바로 부른다.
// cmd /s는 명령줄의 첫·끝 따옴표를 떼므로, 인자를 감싼 명령줄 전체를 한 번 더 "…"로 감싸고 그대로(verbatim) 넘긴다.
// 이렇게 하지 않으면 공백·한글이 든 경로(--extensions-dir 등)가 깨진다(R5, doctor.js와 같은 방식)
const CMD_WRAPPERS = ['code', 'claude', 'gh', 'npm', 'npx', 'agent-browser'];
function run(cmd, args = []) {
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 180000 };
  let r;
  if (process.platform === 'win32' && CMD_WRAPPERS.includes(cmd)) {
    const q = (a) => (/[\s"&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map(q).join(' ')}"`], { ...opts, windowsVerbatimArguments: true });
  } else {
    r = spawnSync(cmd, args, opts);
  }
  return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const codeArgs = (args) => (opt('--extensions-dir') ? ['--extensions-dir', opt('--extensions-dir'), ...args] : args);

function confirm(question) {
  if (flag('--yes')) return true;
  process.stdout.write(`${question} [y/N] `);
  const buf = Buffer.alloc(256);
  let n = 0;
  try {
    n = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  return /^\s*y/i.test(buf.slice(0, n).toString());
}

// 묶음이 옮기지 않는 것: 새 PC에서 사람이 다시 하는 일(import·restore 끝에 출력)
const NEW_PC_TODO = [
  'Claude Code 로그인(claude 실행 후 /login)',
  'GitHub 로그인(gh auth login)',
  '외부 콘솔(배포·호스팅 등) 로그인. 전용 Chrome 프로필은 옮기지 않으므로 새로 로그인합니다',
  'MCP 서버 토큰 다시 입력',
  '비밀값 폴더(.claude/wy-ops.json의 secretsDir, 정했을 때만)를 손으로 직접 복사. 묶음에는 비밀값을 넣지 않습니다',
  'install.ps1 doctor로 남은 항목 확인',
];

// 커밋 안 된 변경·푸시 안 된 커밋(어느 브랜치든). git 저장소가 아니면 빈 목록
function gitPending(project) {
  const git = (args) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true });
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) return [];
  const out = [];
  const changed = String(git(['status', '--porcelain']).stdout || '').split(/\r?\n/).filter(Boolean).length;
  if (changed) out.push(`커밋 안 된 변경 ${changed}개 — 묶음에 들어가지 않습니다. 커밋·푸시하거나 따로 옮기세요`);
  const ahead = String(git(['log', '--branches', '--not', '--remotes', '--oneline']).stdout || '').split(/\r?\n/).filter(Boolean).length;
  if (ahead) out.push(`푸시 안 된 커밋 ${ahead}개 — 새 PC에서 clone하면 없습니다. 먼저 푸시하세요`);
  return out;
}

// 한 줄 입력(입력이 없거나 읽을 수 없으면 빈 문자열)
function ask(question) {
  process.stdout.write(`${question} `);
  const buf = Buffer.alloc(1024);
  let n = 0;
  try {
    n = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    return '';
  }
  return buf.slice(0, n).toString().split(/\r?\n/)[0].trim();
}

function prereqs() {
  const missing = ['git', 'node', 'code', 'claude'].filter((c) => run('where', [c]).status !== 0);
  if (missing.length) throw new Error(`필요한 도구가 PATH에 없습니다: ${missing.join(', ')} (NEW-PC.md의 '1. 설치 전에' 참고)`);
}

// 설치 원본: 이 코드가 git 저장소 안에서 돌면(패키지 clone이나 개발 트리) 그곳, 설치본에서 돌면 deployed.json의 source
function sourcePkg() {
  if (run('git', ['-C', PKG, 'rev-parse', '--show-toplevel']).status === 0) return PKG;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(PKG, 'deployed.json'), 'utf8'));
    if (d.source && typeof d.source === 'object' && d.source.repo) return path.join(d.source.repo, d.source.rel || '');
  } catch {
    // 아래 오류로
  }
  throw new Error('설치 원본(패키지 저장소 clone)을 찾지 못했습니다. 패키지 저장소를 clone한 뒤 그 폴더의 install.ps1로 실행하세요');
}

function deployStep() {
  const { deploy, deployDev } = require('./deploy');
  if (flag('--dev')) {
    const d = deployDev({ pkg: sourcePkg() });
    say(`개발 연결: current → ${d.name} (작업 사본 v${d.version}). 고친 것이 커밋 없이 바로 쓰입니다. 풀려면 install.ps1 deploy`);
    return d;
  }
  const r = deploy({ pkg: sourcePkg() });
  say(`설치본: ${path.join(r.dir, r.name)} (v${r.version}, 커밋 ${r.commit}), current → ${r.name}`);
  if (r.removed.length) say(`오래된 버전 정리: ${r.removed.join(', ')}`);
  return r;
}

// 설치된 껍데기의 해시(extensions.json에서 위치를 찾아 package.json을 읽는다)
function installedStubHash() {
  const dir = opt('--extensions-dir') || path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'extensions.json'), 'utf8'));
    const e = list.find((x) => x.identifier && x.identifier.id === STUB_EXT);
    if (!e) return null;
    const loc = e.location && (e.location.fsPath || e.location.path || '').replace(/^\/([A-Za-z]:)/, '$1');
    return JSON.parse(fs.readFileSync(path.join(loc || path.join(dir, e.relativeLocation || ''), 'package.json'), 'utf8')).wyOpsStubHash || null;
  } catch {
    return null;
  }
}

function extensionStep(dep) {
  const current = path.join(dep.dir, 'current');
  if (installedStubHash() === dep.stubHash) {
    say('확장: 껍데기 확장이 최신입니다(재설치 불필요).');
    return false;
  }
  const { vsix } = require('./vsix');
  const file = path.join(os.tmpdir(), `wy-ops-${dep.stubHash}.vsix`);
  fs.writeFileSync(file, vsix(path.join(current, 'stub-ext')));
  const r = run('code', codeArgs(['--install-extension', file, '--force']));
  try {
    fs.unlinkSync(file); // fs.rmSync는 한글 경로에서 프로세스를 죽인다(R5)
  } catch {
    // 이미 없으면 그만
  }
  if (r.status !== 0) throw new Error(`확장 설치 실패: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  say(`확장: ${STUB_EXT}를 설치했습니다(Reload Window 필요).`);
  return true;
}

// 함께 까는 도구(카드 1110, lib/extras.js): 플러그인 포함. 고른 역할에 필수인 것은 늘 켜고, 나머지는 기본 켬 목록에서 끌 수 있다.
//   ops: 프로젝트 설정(없으면 역할 무관 = 세션 교체(ecc)만 필수). 끌 것: --extras-off a,b 또는 질문(--yes·restore면 묻지 않음)
//   돌려주는 off 목록은 init이 wy-ops.json의 extras.off로 남긴다
function chooseExtras(ops, { ask: canAsk = !flag('--yes') && argv[0] !== 'restore' } = {}) {
  const extras = require('./extras');
  let off = opt('--extras-off') != null ? opt('--extras-off').split(',').map((s) => s.trim()).filter(Boolean) : (ops && ops.extras && ops.extras.off) || [];
  let p = extras.plan({ ops: ops || {}, off });
  say('함께 까는 도구:');
  p.forEach((e, i) => say(`  ${String(i + 1).padStart(2)}. [${e.on ? 'x' : ' '}] ${e.label}${e.required ? ' (고른 역할에 필수)' : ''}${e.forcedBy ? ` (${e.forcedBy.join(', ')}에 필요)` : ''}`));
  if (canAsk && opt('--extras-off') == null) {
    const a = ask('끌 항목 번호(쉼표로, 필수는 못 끔, Enter = 이대로):');
    if (a) {
      const picked = a.split(',').map((s) => p[Number(s.trim()) - 1]).filter(Boolean);
      for (const e of picked) if (e.required) say(`  ${e.label}은 고른 역할에 필수라 끌 수 없습니다`);
      off = [...new Set([...off, ...picked.filter((e) => !e.required).map((e) => e.id)])];
      p = extras.plan({ ops: ops || {}, off });
    }
  }
  return { off, plan: p };
}

function extrasStep(ops, opts = {}) {
  if (flag('--skip-extras') || flag('--skip-plugins')) {
    say('함께 까는 도구: 건너뜀(--skip-extras)');
    return { off: (ops && ops.extras && ops.extras.off) || [], results: [] };
  }
  const extras = require('./extras');
  const { off, plan } = opts.plan ? { off: opts.off || [], plan: opts.plan } : chooseExtras(ops, opts);
  const results = extras.install(plan, { run });
  for (const r of results) say(`  ${r.state === 'ok' ? '있음' : r.state === 'installed' ? '설치함' : r.state === 'skipped' ? '건너뜀' : '실패'}  ${r.id}${r.error ? ` — ${r.error}` : ''}`);
  const failed = results.filter((r) => r.state === 'failed' || r.state === 'skipped');
  if (failed.length) say(`설치하지 못한 것 ${failed.length}개: 위 오류를 보고 직접 설치하거나 다시 실행하세요(doctor가 알려 줍니다)`);
  return { off, results };
}

// 고른 스택의 개발 도구(wy-ops.json tools) 중 없는 것: winget 명령이면 확인받고 설치, 아니면 안내만
function stackToolsStep(ops) {
  const tools = (ops && Array.isArray(ops.tools) ? ops.tools : []).filter(require('./doctor').toolCmds);
  const missing = tools.filter((t) => !require('./doctor').stackToolFound(run, t));
  if (!missing.length) return say(tools.length ? `스택 개발 도구: 모두 있음(${tools.map((t) => t.label || t.cmd).join(', ')})` : '');
  for (const t of missing) {
    const m = /^winget install\s+(?:-e\s+)?(?:--id\s+)?([A-Za-z0-9._-]+)/.exec(t.install || '');
    if (m && !flag('--skip-install') && confirm(`스택 도구 ${t.label || t.cmd}이 없습니다. winget으로 ${m[1]}을 설치할까요?`)) {
      const r = run('winget', ['install', '-e', '--id', m[1], '--accept-source-agreements', '--accept-package-agreements']);
      say(r.status === 0 ? `  설치함 ${m[1]} (새 터미널에서 PATH가 반영됩니다)` : `  설치 실패 ${m[1]}: ${String(r.stderr || r.stdout).trim().split('\n').pop()}`);
    } else say(`  없음 ${t.label || t.cmd}: ${t.install || '설치 안내 없음'}`);
  }
  return undefined;
}

// 이 폴더를 Claude Code가 신뢰하는지(~/.claude.json의 projects[경로].hasTrustDialogAccepted, 읽기만).
// VS Code 작성자 신뢰와 따로이고, 없으면 claude --bg가 'Workspace not trusted'로 뜨지 않는다(R6). 하위 폴더는 위 폴더의 신뢰를 따른다
function claudeTrusted(project, home = os.homedir()) {
  let projects = {};
  try {
    projects = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects || {};
  } catch {
    return null; // 읽지 못하면 모른다
  }
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const want = norm(project);
  return Object.entries(projects).some(([k, v]) => v && v.hasTrustDialogAccepted && (want === norm(k) || want.startsWith(`${norm(k)}/`)));
}

function trustHint(project) {
  if (claudeTrusted(project) !== false) return;
  say(`\n이 폴더는 아직 Claude Code가 신뢰하지 않습니다(${project}). 그 폴더의 터미널에서 claude를 한 번 실행해 'Do you trust the files in this folder?'에 Yes → /exit 하세요.`);
  say('VS Code의 작성자 신뢰와는 따로이고, 이것이 없으면 백그라운드 역할 세션이 "Workspace not trusted"로 뜨지 않습니다.');
}

function printNewPc() {
  const f = path.join(PKG, 'NEW-PC.md');
  if (fs.existsSync(f)) say(`\n${fs.readFileSync(f, 'utf8').trim()}\n`);
}

function projectRoot() {
  const p = opt('--project');
  if (p) return path.resolve(p);
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('저장소 안에서 실행하거나 --project <폴더>를 주세요');
  return path.resolve(r.stdout.trim());
}

const store = () => require('../vscode/approvalStore');
// R4 전환 조건으로 세는 대기 카드: 출처 대조 원장이 지키는 결정 종류(git 계열·choice·permission)만.
// todo(할 일)는 '했음' 결정이 원장 보호 대상이 아니고 전환 뒤에 처리해도 되므로 세지 않는다 — R4를 안내하는 할 일 카드 자체가 걸리던 결함(pm 결정)
const PROTECTED_KINDS = () => new Set([...Object.keys(store().GIT_KINDS), 'choice', 'permission']);
function protectedPending(root) {
  const kinds = PROTECTED_KINDS();
  return store().readState(root).pending.filter((r) => !r.broken && kinds.has(r.kind)).map((r) => r.id);
}
// doctor에 넘길 값: 시험용 --extensions-dir도 함께(설치한 곳과 같은 곳을 점검하게)
const doctorOpts = (project) => ({ repoRoot: project, home: os.homedir(), ...(opt('--extensions-dir') ? { extensionsDir: opt('--extensions-dir') } : {}) });
const extInstalled = (id) => run('code', codeArgs(['--list-extensions'])).stdout.split(/\r?\n/).some((l) => l.trim().toLowerCase() === id);

function settingsStep(project, dep) {
  const settings = require('./settings');
  const hooksDir = path.join(dep.dir, 'current', 'vscode', 'hooks').replace(/\\/g, '/');
  for (const f of ['wy-approval-guard.js', 'wy-message-guard.js', 'wy-permission.js', 'wy-session-start.js', 'wy-context-size.js']) {
    if (!fs.existsSync(path.join(hooksDir, f))) throw new Error(`훅 파일이 없습니다: ${hooksDir}/${f} (훅이 조용히 통과하지 않게 settings를 바꾸지 않습니다)`);
  }
  const file = path.join(project, '.claude', 'settings.local.json');
  const { next, changes } = settings.plan(settings.readSettings(file), hooksDir);
  if (!changes.length) return say('settings: 바꿀 것 없음');
  say(`settings: ${file}`);
  for (const c of changes) say(`  ${settings.describe(c)}`);
  if (!confirm('위처럼 바꿀까요?')) throw new Error('settings를 바꾸지 않고 멈췄습니다');
  const bak = settings.apply(file, next);
  say(bak ? `settings: 바꿨습니다(백업 ${bak})` : 'settings: 새로 만들었습니다');
}

function doctorStep(project, { todos }) {
  let doctor;
  try {
    doctor = require('./doctor');
  } catch {
    return say('doctor: lib/doctor.js가 없어 건너뜁니다');
  }
  const results = doctor.checkAll(doctorOpts(project));
  const order = { fail: 0, warn: 1, ok: 2 };
  for (const r of results.slice().sort((a, b) => order[a.level] - order[b.level])) say(`${r.level === 'ok' ? '  ok ' : r.level === 'warn' ? 'WARN ' : 'FAIL '} ${r.title}${r.detail ? ` — ${r.detail}` : ''}${r.level !== 'ok' && r.fix ? `\n       고치기: ${r.fix}` : ''}`);
  if (todos) {
    const { writeTodo } = require('./todo');
    const root = store().rootFor(project);
    for (const r of results.filter((x) => x.todo)) {
      const w = writeTodo(root, r.todo);
      if (w.written) say(`할 일 카드를 올렸습니다: ${w.id}`);
    }
  }
  return results;
}

// 묶음 들여오기(import·restore 공용). 덮어쓸 파일이 있으면 확인. 들여오지 않았으면(--dry-run·거절) null
function importStep(project, zipFile, include) {
  const t = require('./transfer');
  const plan = t.importState({ project, zip: zipFile, include, dryRun: true });
  const over = plan.files.filter((f) => f.status === 'overwrite');
  say(`들여올 파일 ${plan.files.length}개(새 ${plan.files.filter((f) => f.status === 'new').length}, 같음 ${plan.files.filter((f) => f.status === 'same').length}, 덮어씀 ${over.length})`);
  for (const f of over) say(`  덮어씀 ${f.kind} ${f.target}`);
  if (flag('--dry-run')) return null;
  if (over.length && !confirm('위 파일을 덮어쓸까요? (원래 파일은 백업합니다)')) {
    say('들여오지 않았습니다');
    return null;
  }
  const r = t.importState({ project, zip: zipFile, include });
  say(`들여왔습니다: ${r.files.filter((f) => f.status !== 'same').length}개`);
  if (r.backupDir) say(`백업: ${r.backupDir}`);
  if (r.markedUsed) say(`승인 이력 ${r.markedUsed}건은 '사용됨'으로 표시했습니다(이 PC에서 승인으로 다시 쓰이지 않음)`);
  for (const s of r.skipped || []) say(`  건너뜀 ${s.kind}/${s.rel} — ${s.reason}`);
  const plugins = r.plugins && r.plugins.enabledPlugins ? Object.keys(r.plugins.enabledPlugins).filter((k) => r.plugins.enabledPlugins[k]) : [];
  if (plugins.length) say(`원래 PC에서 켜 둔 플러그인(참고, 필수 플러그인은 setup이 설치): ${plugins.join(', ')}`);
  return r;
}

// global(project 없음)·setup. restore가 중간 단계로 부를 때는 quiet(NEW-PC·Reload 안내 뺌), skipExtras(함께 까는 도구는 setup 단계에서 한 번만)
function setupStep(project, { quiet = false, skipExtras = false } = {}) {
  prereqs();
  // R4 전환 조건: 옛 확장이 있는 PC에서 setup은 승인 대기 카드가 0일 때만(원장이 새로 시작되므로)
  const oldExt = !flag('--skip-extension') && extInstalled(OLD_EXT);
  if (project && oldExt) {
    const pending = protectedPending(store().rootFor(project));
    if (pending.length) throw new Error(`결정을 기다리는 카드가 ${pending.length}장 있습니다(${pending.join(', ')}). 모두 처리한 뒤 다시 실행하세요(확장 전환 때 출처 대조 원장이 새로 시작됩니다)`);
  }
  const dep = deployStep();
  if (!flag('--skip-extension')) {
    if (oldExt && confirm(`옛 확장 ${OLD_EXT}를 제거하고 ${STUB_EXT}로 바꿀까요?`)) {
      run('code', codeArgs(['--uninstall-extension', OLD_EXT]));
      say(`확장: 옛 확장 ${OLD_EXT}를 제거했습니다`);
    }
    extensionStep(dep);
  }
  if (!skipExtras) extrasStep(project ? (require('../vscode/opsConfig').loadOpsConfig(project) || {}) : null);
  if (project) {
    settingsStep(project, dep);
    store().ensureDirs(store().rootFor(project)); // 빈 폴더만 만든다(결정 파일은 쓰지 않음)
    doctorStep(project, { todos: true });
    trustHint(project);
    if (oldExt) say('\n출처 대조 원장을 새로 시작했습니다: 이 시각 전의 결정은 신뢰합니다(확장 id 변경, K4).');
  }
  if (quiet) return;
  printNewPc();
  say('다음: VS Code에서 "Developer: Reload Window"를 실행하세요.');
}

// 복원 대상 폴더: --project, 없으면 원래 경로. 원래 홈 아래였으면 이 PC 홈 아래 같은 자리(사용자 이름이 달라도)
function restoreTarget(src) {
  if (opt('--project')) return path.resolve(opt('--project'));
  if (!src.project) throw new Error('묶음에 원래 프로젝트 경로가 없습니다. --project <폴더>를 주세요');
  const rel = src.home ? path.relative(src.home, src.project) : '';
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(os.homedir(), rel);
  return path.resolve(src.project);
}

// 프로젝트 clone: 이미 git 저장소면 건너뜀, 비어 있지 않은 다른 폴더면 멈춤
function cloneStep(project, repo) {
  if (fs.existsSync(path.join(project, '.git'))) return say(`clone: 이미 있음(${project}), 건너뜁니다`);
  if (fs.existsSync(project) && fs.readdirSync(project).length) throw new Error(`${project}가 비어 있지 않은데 git 저장소가 아닙니다. 다른 폴더를 --project로 주거나 정리한 뒤 다시 실행하세요`);
  if (!repo || !repo.remote) throw new Error('묶음에 원격 저장소 주소가 없습니다. 프로젝트를 직접 clone한 뒤 restore <zip> --project <그 폴더>로 다시 실행하세요');
  say(`clone: ${repo.remote}${repo.branch ? ` (${repo.branch})` : ''} → ${project}`);
  const r = run('git', ['clone', ...(repo.branch ? ['-b', repo.branch] : []), repo.remote, project]);
  if (r.status !== 0) throw new Error(`clone 실패: ${String(r.stderr || r.stdout).trim().split('\n').pop()} (GitHub 로그인이 필요하면 gh auth login 뒤 다시 실행)`);
  return undefined;
}

// 새 PC 할 일: 공통 목록 + 묶음이 알려 준 구체 항목(다시 입력할 토큰·키), 중복 없이
function restoreTodo(src, reenter) {
  const out = NEW_PC_TODO.map((t) => (src.secretsDir && t.startsWith('비밀값 폴더') ? `비밀값 폴더(${src.secretsDir})를 원래 PC에서 손으로 직접 복사. 묶음에는 비밀값을 넣지 않습니다` : t));
  for (const x of reenter || []) out.push(`다시 입력: ${x.where} ${x.key}${x.note ? ` (${x.note})` : ''}`);
  return [...new Set(out)];
}

// restore <zip>(카드 1020): global → clone → import(전역 설정 포함) → setup(doctor 포함) → 새 PC 할 일
function restoreCmd() {
  const zipFile = argv[1] && !argv[1].startsWith('--') ? path.resolve(argv[1]) : null;
  if (!zipFile) throw new Error('restore에는 묶음 파일이 필요합니다: install.ps1 restore <zip> [--project <폴더>]');
  const m = require('./transfer').unzip(fs.readFileSync(zipFile)).get('manifest.json');
  if (!m) throw new Error('manifest.json이 없습니다(wy-ops export로 만든 묶음이 아님)');
  const src = JSON.parse(m.toString('utf8')).source || {};
  const project = restoreTarget(src);
  say('복원 순서: 1) 설치본·확장 2) 프로젝트 clone 3) 묶음 들여오기(전역 설정 포함) 4) 프로젝트 setup·doctor 5) 남은 할 일');
  say(`  프로젝트: ${project}`);
  say(`  원격: ${(src.repo && src.repo.remote) || '(없음)'}${src.repo && src.repo.branch ? ` (${src.repo.branch})` : ''}`);
  say('Claude Code 창·세션을 모두 끈 상태에서 실행하세요(~/.claude.json의 MCP 설정을 병합합니다).');
  if (!confirm('이대로 복원할까요?')) return say('복원하지 않았습니다');
  say('\n[1/5] 설치본·확장');
  setupStep(null, { quiet: true, skipExtras: true });
  say('\n[2/5] 프로젝트 clone');
  cloneStep(project, src.repo);
  say('\n[3/5] 묶음 들여오기');
  const r = importStep(project, zipFile, {});
  say('\n[4/5] 프로젝트 setup');
  setupStep(project, { quiet: true });
  say('\n[5/5] 새 PC에서 직접 할 일(묶음으로 옮기지 않음):');
  for (const line of restoreTodo(src, r ? r.reenter : [])) say(`  - ${line}`);
  say('\n다음: VS Code에서 이 프로젝트 폴더를 열고 "Developer: Reload Window"를 실행하세요.');
  return undefined;
}

function main() {
  const cmd = argv[0];
  if (cmd === 'deploy') return void deployStep();
  if (cmd === 'rollback') {
    const r = require('./deploy').rollback({ name: argv[1] && !argv[1].startsWith('--') ? argv[1] : null });
    return say(`되돌렸습니다: ${r.from || '(없음)'} → ${r.to}. Reload Window를 하세요.`);
  }
  if (cmd === 'doctor') {
    const project = projectRoot();
    if (flag('--json')) return say(JSON.stringify(require('./doctor').checkAll(doctorOpts(project)), null, 2));
    const res = doctorStep(project, { todos: false }) || [];
    process.exitCode = res.some((r) => r.level === 'fail') ? 1 : 0;
    return undefined;
  }
  if (cmd === 'cleanup-legacy') {
    const legacy = require('./legacy');
    const settingsFiles = [path.join(projectRoot(), '.claude', 'settings.local.json')];
    const items = legacy.list(os.homedir(), { settingsFiles });
    if (!items.length) return say('정리할 옛 파일이 없습니다');
    for (const i of items) say(`  ${i.path} — ${i.what}${i.count != null ? ` (${i.count}개)` : ''}${i.inUse ? ' [아직 사용 중: 건너뜀]' : ''}`);
    if (!confirm('위 목록을 지울까요?')) return say('지우지 않았습니다');
    for (const r of legacy.remove(items.filter((i) => !i.inUse), os.homedir(), { settingsFiles })) say(`  ${r.removed ? '지움' : '건너뜀'} ${r.path}${r.reason ? ` (${r.reason})` : ''}`);
    return undefined;
  }
  if (cmd === 'init') {
    const name = opt('--name');
    const prefix = opt('--prefix');
    if (!name || !prefix) throw new Error('init에는 --name <프로젝트 이름>과 --prefix <역할 접두사, 예: AB->가 필요합니다');
    const project = path.resolve(opt('--project') || process.cwd());
    const { toolsDir } = require('./deploy');
    const current = path.join(toolsDir(), 'current');
    if (!fs.existsSync(path.join(current, 'deployed.json'))) throw new Error(`이 PC에 패키지가 없습니다(${current}). 먼저 이 저장소에서 install.ps1 global을 실행하세요`);
    const initLib = require('./init');
    const { VERIFY_KEYS } = require('../gen-agents');
    const stacks = initLib.listStacks();
    let stack = opt('--stack');
    if (!stack) {
      say('기술 스택을 고르세요(개발 도구 점검과 검증 명령이 정해집니다):');
      stacks.forEach((s, i) => say(`  ${i + 1}. ${s.id} — ${s.label}`));
      const a = ask(`번호 또는 이름 [${stacks.findIndex((s) => s.id === 'custom') + 1}]:`);
      stack = stacks[Number(a) - 1] ? stacks[Number(a) - 1].id : a || 'custom';
    }
    // 검증 명령 덮어쓰기: --verify-<키> "<명령>". 직접 입력(custom)이면 빠진 것을 묻는다(--yes면 묻지 않고 비워 둠)
    const verify = {};
    for (const [k, label] of VERIFY_KEYS) {
      if (opt(`--verify-${k}`) != null) verify[k] = opt(`--verify-${k}`);
      else if (stack === 'custom' && !flag('--yes')) verify[k] = ask(`  ${label} 명령(없으면 Enter):`);
    }
    // 역할 구성: --roles <그룹,…>(고르기), --count backend=2,frontend=2(같은 역할 여러 세션), --area "<역할>=<영역>;…"(담당 디렉터리)
    // 직접 주지 않았으면 여러 개로 나눌 수 있는 역할의 수와 영역을 묻는다(--yes면 기본값: 영역은 pm이 배정)
    const catalog = JSON.parse(fs.readFileSync(path.join(PKG, 'templates', 'roles.json'), 'utf8'));
    const roles = opt('--roles') ? opt('--roles').split(',').map((s) => s.trim()).filter(Boolean) : null;
    const pairs = (text, sep) => Object.fromEntries(String(text || '').split(sep).map((s) => s.split('=').map((x) => x.trim())).filter(([k, v]) => k && v != null));
    const counts = Object.fromEntries(Object.entries(pairs(opt('--count'), ',')).map(([k, v]) => [k, Number(v)]));
    const areas = pairs(opt('--area'), ';');
    if (!flag('--yes') && opt('--count') == null && opt('--area') == null) {
      say('같은 역할을 여러 세션으로 나눠 병렬로 일할 수 있습니다(0이면 빼기).');
      for (const g of catalog.groups.filter((x) => x.multi && (!roles || roles.includes(x.id)))) {
        const a = ask(`  ${g.id} 세션 수 [${g.count}]:`);
        if (a) counts[g.id] = Number(a);
        const n = counts[g.id] == null ? g.count : counts[g.id];
        for (let i = 1; n > 1 && i <= n; i++) {
          const v = ask(`    ${prefix}${g.id}${i} 담당 영역(디렉터리, 없으면 Enter = pm이 배정):`);
          if (v) areas[`${prefix}${g.id}${i}`] = v;
        }
      }
    }
    // 함께 까는 도구: 고른 역할로 필수를 정하고, 끌 것을 고른다(wy-ops.json extras.off로 남음)
    const preview = { roles: initLib.expandRoles(catalog, { prefix, only: roles && roles.length ? roles : null, counts, areas }) };
    const chosen = flag('--skip-extras') ? null : chooseExtras(preview);
    const r = initLib.init({ project, name, prefix, stack, verify, roles, counts, areas, principles: !flag('--no-principles'), extrasOff: chosen ? chosen.off : null });
    say(`스택: ${r.ops.stack || '(없음)'} · 역할 ${r.ops.roles.map((x) => x.name).join(', ')}`);
    for (const f of r.files) say(`  ${f.action.padEnd(9)} ${f.file}${f.action === 'modified' || f.action === 'unmanaged' ? ' (그대로 둠)' : ''}`);
    if (r.gitignoreAdded.length) say(`  .gitignore에 더함: ${r.gitignoreAdded.join(', ')}`);
    if (chosen) extrasStep(r.ops, { plan: require('./extras').plan({ ops: r.ops }), off: chosen.off });
    stackToolsStep(r.ops);
    settingsStep(project, { dir: toolsDir() });
    store().ensureDirs(store().rootFor(project));
    doctorStep(project, { todos: true });
    say(`\nCLAUDE.md에 아래 절을 넣으세요(자동으로 고치지 않습니다. 같은 내용: .claude/ops/CLAUDE.part.md${flag('--no-principles') ? '' : ', 작업 원칙 절은 빼도 됩니다'}):\n`);
    say(r.claudeMd.trim());
    trustHint(project);
    say('\n다음: VS Code에서 "Developer: Reload Window"를 실행하세요.');
    return undefined;
  }
  if (cmd === 'update') {
    const project = projectRoot();
    if (!flag('--no-deploy')) {
      // 패키지 저장소를 최신으로(빨리 감기만) → 설치 → 새 설치본의 코드로 나머지(생성 파일 갱신)를 한다
      const src = sourcePkg();
      const top = run('git', ['-C', src, 'rev-parse', '--show-toplevel']).stdout.trim();
      if (!flag('--no-pull') && confirm(`패키지 저장소(${top})를 원격에서 받을까요(git pull --ff-only)?`)) {
        const p = run('git', ['-C', top, 'pull', '--ff-only']);
        if (p.status !== 0) throw new Error(`git pull --ff-only 실패(로컬에서 고친 것이 있으면 정리한 뒤 다시): ${(p.stderr || p.stdout).trim()}`);
        say(p.stdout.trim() || '받았습니다');
      }
      const dep = deployStep();
      const next = path.join(dep.dir, 'current', 'lib', 'install.js');
      if (path.resolve(next).toLowerCase() !== path.resolve(__filename).toLowerCase() && fs.existsSync(next)) {
        const rest = argv.slice(1).filter((a) => a !== '--dev');
        const r = spawnSync(process.execPath, [next, 'update', '--no-deploy', '--project', project, ...rest.filter((a, i, all) => a !== '--project' && all[i - 1] !== '--project')], { stdio: 'inherit' });
        process.exitCode = r.status;
        return undefined;
      }
    }
    const { update, format } = require('./update');
    const version = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
    say(format(update({ project, version, dryRun: flag('--dry-run') })));
    say('다음: VS Code에서 "Developer: Reload Window"를 실행하세요.');
    return undefined;
  }
  if (cmd === 'gen') {
    // 역할 파일·pm-ops 스킬 다시 만들기(.claude/ops 원본을 고친 뒤). 생성기가 lock도 함께 맞춘다
    const project = projectRoot();
    for (const script of ['gen-agents.js', 'gen-skill.js']) {
      const g = spawnSync(process.execPath, [path.join(PKG, script), '--root', project], { encoding: 'utf8' });
      process.stdout.write(g.stdout || '');
      if (g.status !== 0) throw new Error(`${script} 실패: ${(g.stderr || '').trim()}`);
    }
    return undefined;
  }
  if (cmd === 'export') {
    const project = projectRoot();
    // 이전 전 점검: 커밋 안 된 변경·푸시 안 된 커밋은 묶음에 들어가지 않는다(git으로 옮길 것)
    const pending = gitPending(project);
    for (const line of pending) say(`[주의] ${line}`);
    say('역할 세션이 하던 일이 있으면 먼저 진행 상태를 저장하게 하세요(pm이 세션 교체 준비를 지시 → 각 세션이 인수인계 저장).');
    say('묶음은 지금 시점의 사본입니다. 동기화가 아니므로 묶은 뒤 원래 PC에서 바뀐 것은 옮겨지지 않습니다.');
    if (pending.length && !confirm('그래도 묶을까요?')) return say('묶지 않았습니다');
    const include = flag('--no-settings') ? { settingsLocal: false } : {};
    const r = require('./transfer').exportState({ project, out: opt('--out') ? path.resolve(opt('--out')) : undefined, include });
    say(`개인 이전 묶음: ${r.file} (파일 ${r.files.length}개)`);
    for (const s of r.skipped || []) say(`  뺌 ${s.kind}/${s.rel} — ${s.reason}`);
    say('\n개인 USB나 드라이브로만 옮기고, 옮긴 뒤 지우세요.');
    say('비밀값 검사는 이름표가 붙은 토큰·키 모양만 잡습니다. 이름표 없는 비밀값(비밀번호만 적힌 줄 등)은 메모리에 적지 마세요.');
    return undefined;
  }
  if (cmd === 'import') {
    const zipFile = argv[1] && !argv[1].startsWith('--') ? path.resolve(argv[1]) : null;
    if (!zipFile) throw new Error('import에는 묶음 파일이 필요합니다: install.ps1 import <zip> [--project <폴더>]');
    const r = importStep(projectRoot(), zipFile, flag('--no-settings') ? { settingsLocal: false } : {});
    if (!r) return undefined;
    say('\n새 PC에서 다시 할 일(묶음으로 옮기지 않음):');
    for (const t of NEW_PC_TODO) say(`  - ${t}`);
    return undefined;
  }
  if (cmd === 'restore') return void restoreCmd();
  if (cmd === 'global' || cmd === 'setup') {
    setupStep(cmd === 'setup' ? projectRoot() : null);
    return undefined;
  }
  say('사용법: install.ps1 deploy | global | setup | init --name <이름> --prefix <XX-> [--stack <id>] [--count …] [--area …] [--no-principles] | gen | update | doctor | rollback [버전] | cleanup-legacy | export [--out <zip>] | import <zip> [--dry-run] | restore <zip>  [--yes] [--no-settings] [--project <폴더>] [--skip-plugins] [--skip-extension]');
  process.exitCode = 64;
  return undefined;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`실패: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { run, installedStubHash, protectedPending, claudeTrusted };
