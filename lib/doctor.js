// 운영 도구 점검(OPS-10-1, tools/PACKAGING-PLAN.md 4장). 읽기만 한다 — 어떤 파일도 쓰지 않는다(OPS-10-3).
//   checkAll(opts) → [{ id, title, level: 'ok'|'warn'|'fail', detail, fix, todo? }]
//     opts = { repoRoot, home, toolsDir, extensionsDir, approvalsRoot, settingsFile, run, platform }
//       toolsDir 기본 deploy.toolsDir()(WY_TOOLS_DIR가 있으면 그 아래 wy-ops), extensionsDir 기본 <home>/.vscode/extensions
//       (setup의 --extensions-dir과 같은 값을 넘기면 code에도 붙여 부른다), approvalsRoot 기본 approvalStore.rootFor(repoRoot),
//       settingsFile 기본 <repoRoot>/.claude/settings.local.json, run(cmd, args, { cwd }?) → { status, stdout } (테스트에서 바꿔 끼운다)
//     fix: 고치는 명령 한 줄. todo: 자동으로 확인할 수 없거나 미충족인 손일(lib/todo.js writeTodo가 그대로 받는 형식)
// CLI: node tools/wy-ops/lib/doctor.js [--json] [--project <폴더>] [--extensions-dir <폴더>]   fail이 하나라도 있으면 종료 코드 1
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readSettings, hookScriptInfo } = require('./settings');
const wt = require('./worktree');

const PKG = path.join(__dirname, '..');
const TEMPLATE = path.join(PKG, 'templates', 'settings.hooks.json');
const PLUGINS = path.join(PKG, 'plugins.json');
const STUB_ID = 'wy-ops.wy-ops';
const OLD_EXT_ID = 'erp-project.erp-session-dashboard'; // 옛 확장 id 정리용(패키지화 전 설치본 경고)
const GITIGNORE_LINES = ['.claude/settings.local.json', '.claude/wy-ops.local.json', '.claude/*.bak-*', '.claude/worktrees/'];
// worktree 폴더(S4): 빠지면 'git add -A'가 worktree를 gitlink로 커밋한다. update는 .gitignore를 고치지 않아 기존 프로젝트는 init을 다시 할 때까지 빠져 있으므로 warn
const GITIGNORE_WARN = ['.claude/worktrees/'];
// 고치기 안내에 쓰는 명령: 설치본의 install.ps1(프로젝트 저장소에 패키지 코드가 없어도 된다)
const INSTALL = 'powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\\.wy-tools\\wy-ops\\current\\install.ps1"';

const slash = (p) => String(p || '').replace(/\\/g, '/');
const lower = (p) => slash(p).toLowerCase().replace(/\/+$/, '');
const under = (file, dir) => lower(file).startsWith(lower(dir) + '/');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

// Windows에서 code·claude·gh는 .cmd 래퍼라 cmd.exe로 부르고, 나머지(node·git·powershell·where)는 바로 부른다.
// cmd /s /c는 문자열의 첫·끝 따옴표를 떼므로, 명령줄 전체를 한 번 더 따옴표로 감싸고 node가 다시 이스케이프하지 않게 한다
// (그러지 않으면 공백이 든 경로 인자가 깨진다 — R5 리허설에서 찾음). 출력만 보고 아무것도 쓰지 않는다
const CMD_WRAPPERS = ['code', 'claude', 'gh', 'npm', 'npx', 'agent-browser'];
function defaultRun(cmd, args = [], extra = {}) {
  const opts = { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...extra };
  let r;
  if (process.platform === 'win32' && (CMD_WRAPPERS.includes(cmd) || /\.cmd$/i.test(cmd))) {
    const quote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    const line = [cmd, ...args].map(quote).join(' ');
    r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  } else {
    r = spawnSync(cmd, args, opts);
  }
  return { status: r.error ? null : r.status, stdout: r.stdout || '' };
}

function result(id, title, level, detail, fix = '', todo) {
  return { id, title, level, detail, fix, ...(todo ? { todo } : {}) };
}

/* ── 점검 항목(계획 4장 표 순서) ── */

function checkTools(o) {
  const missing = [];
  const notes = [];
  const major = Number(String(process.versions.node).split('.')[0]);
  if (major < 18) missing.push(`node 18 이상(지금 ${process.versions.node})`);
  for (const [cmd, args, label] of [['git', ['--version'], 'git'], ['code', ['--version'], 'code(VS Code, PATH)'], ['claude', ['--version'], 'claude(Claude Code CLI)']]) {
    const r = o.run(cmd, args);
    if (r.status !== 0) missing.push(label);
    else notes.push(`${label.split('(')[0]} ${String(r.stdout).trim().split(/\r?\n/)[0]}`);
  }
  const ps = o.run('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  const psv = String(ps.stdout).trim();
  if (ps.status !== 0 || !/^5\.1|^[67]\./.test(psv)) missing.push(`PowerShell 5.1${psv ? `(지금 ${psv})` : ''}`);
  if (missing.length) return result('tools', '전제 도구', 'fail', `없음: ${missing.join(', ')}`, '설치: git https://git-scm.com · node https://nodejs.org · VS Code https://code.visualstudio.com(셸 명령 code 설치) · Claude Code https://docs.claude.com/claude-code');
  return result('tools', '전제 도구', 'ok', notes.join(' · '));
}

function repoVersion(o) {
  let version = null;
  try {
    version = readJson(path.join(PKG, 'package.json')).version || null;
  } catch {
    // R2 전에는 패키지 버전 파일이 없다
  }
  const head = o.run('git', ['-C', o.repoRoot, 'rev-parse', '--short', 'HEAD']);
  return { version, commit: head.status === 0 ? String(head.stdout).trim() : null };
}

function readDeployed(o) {
  try {
    return readJson(path.join(o.toolsDir, 'current', 'deployed.json'));
  } catch {
    return null;
  }
}

// 설치본 커밋..HEAD 사이에 바뀐 배포 대상 파일(패키지 기준 경로). 이름 바꾸기는 지움+추가로 본다. 읽지 못하면 null
function deployedChanges(o, d, head) {
  if (!d.commit) return null;
  const prefix = d.source.rel ? `${d.source.rel}/` : '';
  const r = o.run('git', ['-C', d.source.repo, 'diff', '--name-only', '--no-renames', '-z', d.commit, head, ...(prefix ? ['--', prefix] : [])]);
  if (r.status !== 0) return null;
  const { skip } = require('./deploy');
  return String(r.stdout).split('\0').filter((f) => f && f.startsWith(prefix)).map((f) => f.slice(prefix.length)).filter((f) => !skip(f));
}

function checkInstall(o) {
  const cur = path.join(o.toolsDir, 'current');
  if (!exists(cur)) return result('install', '설치본', 'fail', `${slash(cur)} 없음(패키지가 설치되지 않음)`, `${INSTALL} deploy`);
  const d = readDeployed(o);
  if (!d) return result('install', '설치본', 'fail', `${slash(cur)}/deployed.json을 읽지 못함`, `${INSTALL} deploy`);
  if (d.dev) return result('install', '설치본', 'warn', `개발 연결 중: current → ${slash(d.source && d.source.repo)} (작업 사본 v${d.version})`, `${INSTALL} deploy (개발 연결을 풀고 커밋된 버전 설치)`);
  // 패키지 저장소 clone에서 설치한 것: 그 clone의 HEAD와 비교(pull 뒤 deploy를 안 했으면 다름)
  if (d.source && typeof d.source === 'object' && d.source.repo) {
    const head = o.run('git', ['-C', d.source.repo, 'rev-parse', '--short', 'HEAD']);
    const h = head.status === 0 ? String(head.stdout).trim() : null;
    if (!h) return result('install', '설치본', 'warn', `${d.version} @ ${String(d.commit || '').slice(0, 7)} — 설치 원본 ${slash(d.source.repo)}을 읽지 못함`, '패키지 저장소를 다시 clone한 뒤 그 폴더의 install.ps1 deploy');
    if (!String(d.commit || '').startsWith(h) && !h.startsWith(String(d.commit || '-'))) {
      // 커밋이 달라도 그 사이에 배포 대상(deploy가 복사하는 파일)이 안 바뀌었으면(docs·생성물만) 통과. diff를 못 읽으면 실패
      const changed = deployedChanges(o, d, h);
      if (changed && !changed.length) return result('install', '설치본', 'ok', `설치본 ${String(d.commit).slice(0, 7)} (HEAD ${h}, 배포 대상 변경 없음)`);
      const what = changed ? `, 배포 대상 변경: ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` 외 ${changed.length - 3}개` : ''}` : '';
      return result('install', '설치본', 'fail', `설치본 ${String(d.commit || '?').slice(0, 7)}이 패키지 저장소 HEAD ${h}와 다름${what}`, `${INSTALL} deploy`);
    }
    return result('install', '설치본', 'ok', `${d.version} @ ${String(d.commit || '').slice(0, 7)} (원본 ${slash(d.source.repo)})`);
  }
  const want = repoVersion(o);
  const same = (a, b) => !!a && !!b && (String(a).startsWith(b) || String(b).startsWith(a));
  const diffs = [];
  if (want.version && d.version !== want.version) diffs.push(`버전 ${d.version || '?'} → 저장소 ${want.version}`);
  if (want.commit && !same(d.commit, want.commit)) diffs.push(`커밋 ${String(d.commit || '?').slice(0, 7)} → HEAD ${want.commit}`);
  if (diffs.length) return result('install', '설치본', 'fail', `설치본이 저장소와 다름: ${diffs.join(', ')}`, `${INSTALL} deploy`);
  return result('install', '설치본', 'ok', `${d.version || '버전 없음'} @ ${String(d.commit || '').slice(0, 7)}${want.version ? '' : ' (저장소 package.json 버전 없음)'}`);
}

function readSettingsSafe(o) {
  try {
    return { s: readSettings(o.settingsFile) };
  } catch (err) {
    return { error: err.message };
  }
}

function checkHooks(o, template) {
  const { s, error } = readSettingsSafe(o);
  if (error) return result('hooks', `훅 ${template.hooks.length}종`, 'fail', `${slash(o.settingsFile)}을 읽지 못함: ${error}`, `${INSTALL} setup`);
  const hooksDir = path.join(o.toolsDir, 'current', 'vscode', 'hooks');
  const problems = [];
  for (const t of template.hooks) {
    const groups = (s.hooks && s.hooks[t.event]) || [];
    const infos = groups
      .filter((g) => (g.matcher || null) === (t.matcher || null))
      .flatMap((g) => g.hooks || [])
      .map(hookScriptInfo);
    const found = infos.map((i) => i.script).find((p) => p && path.posix.basename(p) === t.script);
    const label = `${t.event}${t.matcher ? `(${t.matcher})` : ''} ${t.script}`;
    // 경로가 틀리면 Claude Code가 훅을 조용히 건너뛰어 보호가 꺼진다 — 가장 중요한 점검
    if (!found && infos.some((i) => i.unknown)) problems.push(`${label}: 판단 불가(훅 명령에서 스크립트 경로를 확실히 읽지 못함 — 공백 든 경로는 따옴표로 감싸거나 args 배열로)`);
    else if (!found) problems.push(`${label}: 없음`);
    else if (!exists(found)) problems.push(`${label}: 파일 없음 ${found}`);
    else if (!under(found, hooksDir)) problems.push(`${label}: current 밖을 가리킴 ${found}`);
  }
  if (problems.length) return result('hooks', `훅 ${template.hooks.length}종`, 'fail', problems.join(' / '), `${INSTALL} setup`);
  return result('hooks', `훅 ${template.hooks.length}종`, 'ok', `모두 ${slash(hooksDir)} 아래에 있음`);
}

function checkDeny(o, template) {
  const { s, error } = readSettingsSafe(o);
  if (error) return result('deny', 'deny 줄', 'fail', `settings를 읽지 못함: ${error}`, `${INSTALL} setup`);
  const have = new Set(((s.permissions && s.permissions.deny) || []).map(String));
  const missing = template.deny.filter((d) => !have.has(d));
  if (missing.length) return result('deny', 'deny 줄', 'fail', `빠진 줄 ${missing.length}개: ${missing.join(', ')}`, `${INSTALL} setup`);
  return result('deny', 'deny 줄', 'ok', `${template.deny.length}줄 모두 있음`);
}

// 원격 창의 백그라운드 세션은 PATH 맨 앞에 VS Code 서버의 remote-cli/code.cmd가 온다. 그 code는 VS Code 터미널 밖에서
// 'Command is only available in WSL or inside a Visual Studio Code terminal.'만 내고 exit 0으로 끝나 확장 목록이 빈 것처럼 보인다.
// 이 출력이 나오면 where로 찾은 code 가운데 remote-cli가 아닌 것으로 다시 부른다(없으면 실행 못 함으로)
const REMOTE_CLI_ONLY = /only available in WSL or inside a Visual Studio Code terminal/i;
function installedExtensions(o) {
  const args = ['--list-extensions', '--show-versions', ...(o.extensionsDir ? ['--extensions-dir', o.extensionsDir] : [])];
  let r = o.run('code', args);
  if (r.status === 0 && REMOTE_CLI_ONLY.test(r.stdout)) {
    const w = o.run('where', ['code']);
    const other = w.status === 0 ? String(w.stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => /\.cmd$/i.test(l) && !/[\\/]remote-cli[\\/]/i.test(l)) : null;
    if (!other) return null;
    r = o.run(other, args);
    if (REMOTE_CLI_ONLY.test(r.stdout)) return null;
  }
  if (r.status !== 0) return null;
  return String(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [id, version] = l.split('@');
    return { id: id.toLowerCase(), version };
  });
}

// 껍데기 확장 폴더: <확장 폴더>/extensions.json의 위치
function stubFolder(o) {
  try {
    const list = readJson(path.join(o.extensionsDir || path.join(o.home, '.vscode', 'extensions'), 'extensions.json'));
    const e = list.find((x) => x && x.identifier && String(x.identifier.id).toLowerCase() === STUB_ID);
    if (!e) return null;
    const p = (e.location && (e.location.fsPath || e.location.path)) || path.join(o.extensionsDir || path.join(o.home, '.vscode', 'extensions'), e.relativeLocation || '');
    return p.replace(/^\/([A-Za-z]:)/, '$1');
  } catch {
    return null;
  }
}

function checkExtension(o) {
  const list = installedExtensions(o);
  if (!list) return result('extension', '확장', 'fail', 'code --list-extensions를 실행하지 못함', 'VS Code 명령 팔레트 → Shell Command: Install \'code\' command in PATH');
  const stub = list.find((e) => e.id === STUB_ID);
  const old = list.find((e) => e.id === OLD_EXT_ID);
  if (!stub) return result('extension', '확장', 'fail', `껍데기 확장 ${STUB_ID} 없음${old ? `(옛 ${OLD_EXT_ID}@${old.version}만 있음)` : ''}`, `${INSTALL} setup`);
  const d = readDeployed(o);
  let hash = null;
  const folder = stubFolder(o);
  try {
    hash = folder ? readJson(path.join(folder, 'package.json')).wyOpsStubHash || null : null;
  } catch {
    hash = null;
  }
  if (d && d.stubHash && hash !== d.stubHash) return result('extension', '확장', 'fail', `껍데기 확장의 contributes가 설치본과 다름(${hash || '해시 없음'} ≠ ${d.stubHash}) — 뷰·명령 목록이 바뀜`, `${INSTALL} setup`);
  // 껍데기 확장 버전과 패키지(설치본) 버전은 따로 간다(껍데기는 contributes가 바뀔 때만 다시 설치) — 둘을 나눠 보인다
  const label = `${STUB_ID}(껍데기) · 확장 코드 ${stub.version}${d && d.version ? ` · 패키지 ${d.version}` : ''}`;
  if (old) return result('extension', '확장', 'warn', `${label}. 옛 ${OLD_EXT_ID}@${old.version}이 남아 있음(같은 화면이 두 번 뜰 수 있음)`, `code --uninstall-extension ${OLD_EXT_ID}`);
  return result('extension', '확장', 'ok', label);
}

// plugins.json의 version은 최소 버전(pm 결정: 마켓플레이스가 개별 버전 고정을 못 하므로 설치는 늘 최신을 받는다).
// 숫자 부분을 차례로 비교한다. 읽을 수 없는 버전은 낮다고 보지 않는다
function versionBelow(have, min) {
  const parts = (v) => String(v || '').split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  const a = parts(have);
  const b = parts(min);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

function readPlugins() {
  const raw = readJson(PLUGINS);
  return Array.isArray(raw) ? raw : raw.plugins || [];
}

function checkPlugins(o) {
  let want;
  try {
    want = readPlugins();
  } catch (err) {
    return result('plugins', '플러그인', 'fail', `plugins.json을 읽지 못함: ${err.message}`, '');
  }
  // enabled는 실행 폴더의 프로젝트 settings를 따르므로 대상 프로젝트에서 부른다(KI-07: 다른 폴더에서 검사하면 그 폴더가 끈 것이 '꺼져 있음'으로 나왔음)
  const r = o.run('claude', ['plugin', 'list', '--json'], { cwd: o.repoRoot });
  let have;
  try {
    have = r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    have = null;
  }
  if (!Array.isArray(have)) return result('plugins', '플러그인', 'fail', 'claude plugin list --json을 읽지 못함', 'claude --version으로 Claude Code CLI 설치·로그인 확인');
  const byId = new Map(have.map((p) => [p.id, p]));
  // 함께 까는 도구 계획(extras)이 있으면 그것으로 필요 여부를 정한다: 켜짐 = 필요, 끔(extras.off) = '꺼짐'
  const planned = extrasPlan(o);
  const pluginOn = new Map();
  if (planned) for (const it of planned.items.filter((x) => x.kind === 'plugin')) pluginOn.set(it.plugin, planned.plan.find((e) => e.id === it.id));
  const fails = [];
  const warns = [];
  const notes = [];
  const fixes = [];
  const projectOff = o.repoRoot ? require('./extras').projectPluginsOff(o.repoRoot) : new Set();
  for (const p of want) {
    const got = byId.get(p.id);
    const e = pluginOn.get(p.id);
    // 프로젝트 settings(enabledPlugins false, local 우선)가 이 프로젝트에서 끈 것은 표준이라 실패로 치지 않는다(SKL, D-22).
    // CLI의 projectEnabled는 '프로젝트 settings가 켜는가'라서 언급이 없어도 false다 — 판정에 쓰지 않는다
    if (projectOff.has(p.id)) {
      notes.push(`${p.id} 프로젝트에서 끔(표준)`);
      continue;
    }
    if (e && !e.on) {
      notes.push(`${p.id} 꺼짐(설정)`);
      continue;
    }
    if (e) p.required = true;
    const install = `claude plugin marketplace add ${p.marketplace} && claude plugin install ${p.id}`;
    if (!got) {
      if (p.required) {
        fails.push(`${p.id} 없음`);
        fixes.push(install);
      } else notes.push(`선택 ${p.id} 없음`);
    } else if (got.enabled === false) {
      if (p.required) {
        fails.push(`${p.id} 꺼져 있음`);
        fixes.push(`claude plugin enable ${p.id}`);
      } else notes.push(`선택 ${p.id} 꺼짐`);
    } else if (p.required && p.version && versionBelow(got.version, p.version)) {
      warns.push(`${p.id} ${got.version}(최소 ${p.version})`);
    } else notes.push(`${p.id} ${got.version}`);
  }
  if (fails.length) return result('plugins', '플러그인', 'fail', [...fails, ...warns].join(', '), fixes.join(' ; '));
  if (warns.length) return result('plugins', '플러그인', 'warn', `최소 버전보다 낮음: ${warns.join(', ')}(일은 막지 않음)`, 'claude plugin marketplace update && claude plugin update <플러그인>');
  return result('plugins', '플러그인', 'ok', notes.join(' · '));
}

// 함께 까는 도구 계획: 프로젝트 설정(역할·extras.off)으로. extras.json이 없는 패키지면 null
function extrasPlan(o) {
  let extras;
  try {
    extras = require('./extras');
  } catch {
    return null;
  }
  const { ops } = opsConfig(o);
  const items = extras.load();
  return { extras, items, plan: extras.plan({ ops: ops || {}, items }) };
}

// 플러그인 밖의 함께 까는 도구(npm·pipx·스킬·MCP): 끈 것은 '꺼짐'(실패 아님), 필수가 없으면 실패, 선택이 없으면 주의
function checkExtras(o) {
  const planned = extrasPlan(o);
  if (!planned) return result('extras', '함께 까는 도구', 'ok', 'extras.json 없음');
  const items = planned.items.filter((x) => x.kind !== 'plugin');
  const st = planned.extras.check({ run: o.run, home: o.home, items, plan: planned.plan });
  const byId = new Map(planned.plan.map((e) => [e.id, e]));
  const label = (id) => (byId.get(id) && byId.get(id).label) || id;
  const missing = st.filter((s) => s.state === 'missing');
  const off = st.filter((s) => s.state === 'off').map((s) => s.id);
  const offText = off.length ? ` · 꺼짐: ${off.join(', ')}` : '';
  if (!missing.length) return result('extras', '함께 까는 도구', 'ok', `${st.filter((s) => s.state === 'ok').map((s) => s.id).join(', ')}${offText}`);
  const req = missing.filter((s) => byId.get(s.id) && byId.get(s.id).required);
  const detail = `없음: ${missing.map((s) => `${label(s.id)}${s.detail ? `(${s.detail})` : ''}`).join(', ')}${offText}`;
  return result('extras', '함께 까는 도구', req.length ? 'fail' : 'warn', detail, `${INSTALL} setup (빠진 것을 설치) · 쓰지 않을 선택 항목은 wy-ops.json의 extras.off에 id를 적음(사용자)`);
}

function checkApprovals(o) {
  if (!o.approvalsRoot) return result('approvals', '승인 폴더', 'fail', '승인 폴더 위치를 정하지 못함(wy-ops.json approvals.namespace)', `${INSTALL} setup`);
  if (!exists(o.approvalsRoot)) return result('approvals', '승인 폴더', 'fail', `${slash(o.approvalsRoot)} 없음`, `${INSTALL} setup`);
  try {
    fs.accessSync(o.approvalsRoot, fs.constants.W_OK);
  } catch {
    return result('approvals', '승인 폴더', 'fail', `${slash(o.approvalsRoot)}에 쓸 수 없음`, '폴더 권한 확인');
  }
  return result('approvals', '승인 폴더', 'ok', slash(o.approvalsRoot));
}

// 승인 센터 기기 명부(호스트 하나: 승인 바탕 폴더/.trust/devices.json): 서명 검증의 기준은 각 기기에 있어 여기서는 수만 센다
function checkDevices() {
  const trust = require('../vscode/approvalTrust');
  const s = trust.summary();
  if (!s.devices) {
    // 0.13.0 전 구조(승인 폴더마다 decisions/trust/devices.json)에 뿌리가 있는 명부가 있으면 승인 센터가 처음 열릴 때 그것을 가져온다(importLegacy)
    const store = require('../vscode/approvalStore');
    const legacy = trust.approvalRoots().filter((root) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(store.paths(root).decisions, 'trust', 'devices.json'), 'utf8'));
        return !!trust.rosterRoot(Array.isArray(r.entries) ? r.entries : []);
      } catch {
        return false;
      }
    });
    if (legacy.length) return result('approval-devices', '승인 기기', 'ok', `전역 기기 명부 없음 · 옛 명부 ${legacy.length}곳(${legacy.map((r) => path.basename(r)).join(', ')}) — 승인 센터를 열면 옛 명부를 가져옴`);
    return result('approval-devices', '승인 기기', 'ok', '기기 명부 없음(호스트 PC 로컬 VS Code 창에서 승인 센터를 처음 열면 그 기기가 뿌리가 됨)');
  }
  const detail = `승인 기기 ${s.devices}대${s.revoked ? `(해제 ${s.revoked})` : ''}${s.joins ? ` · 등록 대기 ${s.joins}` : ''}${s.unknown ? ` · 서명 확인 안 되는 명부 줄 ${s.unknown}` : ''}`;
  if (s.unknown) return result('approval-devices', '승인 기기', 'warn', detail, '세션이 명부를 고쳤을 수 있음: 승인 센터 기기 목록에서 확인 안 됨 기기를 보고 pm에 알림');
  if (s.joins) return result('approval-devices', '승인 기기', 'warn', detail, "등록된 기기의 승인 센터에서 '새 기기 등록 요청'을 새 기기 창의 지문과 비교해 승인(사용자)");
  return result('approval-devices', '승인 기기', 'ok', detail);
}

// 커밋되는 wy-ops.json을 확인한 뒤, PC별 wy-ops.local.json 덮어쓰기까지 합친 값을 쓴다(opsConfig.loadOpsConfig와 같은 규칙)
function opsConfig(o) {
  const file = path.join(o.repoRoot, '.claude', 'wy-ops.json');
  if (!exists(file)) return { error: `${slash(file)} 없음` };
  try {
    readJson(file);
  } catch (err) {
    return { error: `${slash(file)}을 읽지 못함: ${err.message}` };
  }
  const merged = require('../vscode/opsConfig').loadOpsConfig(o.repoRoot);
  if (!merged) return { error: `${slash(file)}이 객체가 아님` };
  return { ops: merged, file };
}
const initHint = (c) => (c.ops && c.ops.project && c.ops.rolePrefix ? `${INSTALL} init --name ${c.ops.project} --prefix ${c.ops.rolePrefix} --yes` : `${INSTALL} init`);

// 생성물과 lock(.claude/wy-ops.lock.json) 대조: 정상 생성 경로(gen-agents·gen-skill·update)는 lock을 함께 맞추므로,
// 어긋나 있으면 사람이 생성물을 직접 고친 것이다. 그대로 두면 update가 그 파일을 '사람이 고침'으로 보고 건너뛴다(84cd6e5 뒤 결함)
function checkLock(o) {
  const lock = require('./lock');
  if (!fs.existsSync(path.join(o.repoRoot, lock.LOCK))) return result('lock', '생성 파일 lock', 'ok', 'lock 없음(init 전 프로젝트)');
  const d = lock.drift(o.repoRoot);
  if (!d.length) return result('lock', '생성 파일 lock', 'ok', `생성물 ${Object.keys(lock.readLock(o.repoRoot).files).filter((k) => /^\.claude\/(agents|skills)\//.test(k)).length}개가 lock과 같음`);
  const list = d.map((x) => `${x.file}(${x.state === 'missing' ? '없음' : '다름'})`).join(', ');
  return result('lock', '생성 파일 lock', 'warn', `lock과 다른 생성물: ${list}. 생성물을 직접 고쳤다면 원본(.claude/ops/·템플릿)을 고친 뒤 다시 생성하세요`, `${INSTALL} gen (원본에서 다시 만들면 lock도 맞춰짐)`);
}

// 검증 명령(wy-ops.json의 verify): 역할 파일·CLAUDE.md의 검증 목록이 된다. 하나도 없거나 { 폴더: 명령 }의 폴더가 없으면 알린다
function checkVerify(o) {
  const { ops } = opsConfig(o);
  if (!ops) return result('verify', '검증 명령', 'ok', '설정 없음(설정 항목 참고)');
  const { VERIFY_KEYS, verifyValue, isMap } = require('../gen-agents');
  const v = ops.verify && typeof ops.verify === 'object' ? ops.verify : {};
  const set = VERIFY_KEYS.filter(([k]) => verifyValue(v[k]));
  if (!set.length) return result('verify', '검증 명령', 'warn', '검증 명령이 없습니다 — 코드가 생긴 뒤 install.ps1 detect --apply로 채우세요(직접 적어도 됨: .claude/wy-ops.json의 verify)', `${INSTALL} detect --apply (폴더를 다시 보고 verify를 채움) 뒤 ${INSTALL} gen`);
  const dirs = [...new Set(VERIFY_KEYS.flatMap(([k]) => (isMap(v[k]) ? Object.keys(v[k]) : [])))];
  const gone = dirs.filter((d) => !exists(path.join(o.repoRoot, d)));
  if (gone.length) return result('verify', '검증 명령', 'warn', `verify에 적힌 폴더가 없습니다: ${gone.join(', ')}`, `.claude/wy-ops.json의 verify를 고친 뒤 ${INSTALL} gen`);
  return result('verify', '검증 명령', 'ok', set.map(([, label]) => label).join(', '));
}

// 고른 스택의 개발 도구(wy-ops.json의 tools: [{ cmd, label, install }]). init이 스택에서 복사하고 프로젝트가 고칠 수 있다.
// 있는지만 본다(where, 실행하지 않음). 고른 스택에만 하고, 없으면 설치 안내만 낸다(이 PC에 설치하지 않음)
// 프로젝트가 고정한 패키지 버전(wy-ops.json의 wyOpsVersion)과 설치본 버전
function checkVersionPin(o) {
  const { ops } = opsConfig(o);
  const pin = ops && ops.wyOpsVersion;
  const d = readDeployed(o);
  if (!pin) return result('version-pin', '패키지 버전 고정', 'ok', '고정하지 않음(wyOpsVersion 없음)');
  if (!d) return result('version-pin', '패키지 버전 고정', 'ok', `고정 ${pin} — 설치본 없음(설치본 항목 참고)`);
  if (d.version === pin) return result('version-pin', '패키지 버전 고정', 'ok', `${pin}`);
  return result('version-pin', '패키지 버전 고정', 'warn', `프로젝트는 ${pin}을 쓰는데 설치본은 ${d.version}${d.dev ? '(개발 연결)' : ''}`, `패키지 저장소에서 ${pin} 태그·커밋으로 맞춰 deploy하거나, 새 버전을 쓰기로 했으면 wy-ops.json의 wyOpsVersion을 바꿈(사용자)`);
}

// where로 찾되, WindowsApps에만 있으면(설치 안 된 스토어 별칭 python.exe 등일 수 있음) --version이 성공해야 있음으로 본다
function toolFound(run, cmd) {
  const w = run('where', [cmd]);
  if (w.status !== 0) return false;
  const hits = String(w.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!hits.length || hits.some((p) => !/[\\/]WindowsApps[\\/]/i.test(p))) return true;
  return hits.some((p) => run(p, ['--version']).status === 0);
}

// 스택 도구 항목의 명령: cmd 하나, 또는 anyOf(여럿 중 하나만 있으면 됨, 예: C++ 컴파일러 cl·clang·g++). 이름이 이상하면 null(건너뜀)
function toolCmds(t) {
  const list = t && (Array.isArray(t.anyOf) ? t.anyOf : [t.cmd]);
  return list && list.length && list.every((c) => /^[A-Za-z0-9._+-]+$/.test(c || '')) ? list : null;
}

function stackToolFound(run, t) {
  return toolCmds(t).some((c) => toolFound(run, c));
}

function checkStackTools(o) {
  const { ops } = opsConfig(o);
  const label = ops ? require('../gen-agents').stackLabel(ops) : '';
  const tools = ops && Array.isArray(ops.tools) ? ops.tools.filter(toolCmds) : [];
  if (!tools.length) return result('stack-tools', '스택 개발 도구', 'ok', label ? `${label}: 확인할 도구 없음` : '스택 도구 목록 없음');
  const missing = tools.filter((t) => !stackToolFound(o.run, t));
  const names = (list) => list.map((t) => t.label || t.cmd).join(', ');
  if (!missing.length) return result('stack-tools', '스택 개발 도구', 'ok', `${label || '프로젝트'}: ${names(tools)}`);
  return result('stack-tools', '스택 개발 도구', 'warn', `${label || '프로젝트'}: 없음 — ${names(missing)}`, missing.map((t) => `${t.label || t.cmd}: ${t.install || '설치 안내 없음'}`).join(' · '));
}

function checkConfig(o) {
  const { ops, error } = opsConfig(o);
  if (error) return result('config', '설정', 'fail', error, `${INSTALL} init`);
  const problems = [];
  if (!ops.project) problems.push('project 없음');
  const roles = Array.isArray(ops.roles) ? ops.roles : [];
  if (!roles.length) problems.push('roles가 비어 있음');
  const names = new Set(roles.map((r) => r && r.name));
  if (roles.some((r) => !r || !r.name)) problems.push('이름 없는 역할');
  for (const k of ['pmRole', 'commitRole']) if (!ops[k] || !names.has(ops[k])) problems.push(`${k}(${ops[k] || '없음'})가 roles에 없음`);
  const ns = ops.approvals && ops.approvals.namespace;
  if (!ns || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(ns)) problems.push('approvals.namespace 형식이 틀림');
  if (problems.length) return result('config', '설정', 'fail', `wy-ops.json: ${problems.join(', ')}`, '.claude/wy-ops.json을 고친 뒤(사용자) 다시 doctor');
  const gen = o.run('node', [path.join(PKG, 'gen-agents.js'), '--check', '--root', o.repoRoot]);
  if (gen.status !== 0) {
    const why = String(gen.stdout).trim().split(/\r?\n/).filter((l) => !l.startsWith('같음')).slice(0, 2).join(' '); // 같은 파일 줄은 빼고 다른 줄만
    return result('config', '설정', 'fail', `역할 파일(.claude/agents)이 원본과 다름${why ? `: ${why}` : ''}`, `${INSTALL} gen`);
  }
  // D-36: pm도 역할 파일로 뜬다. 예전 설치에 남은 pm의 agent:false는 gen-agents가 무시한다(알림만)
  const pmOld = roles.some((r) => r.name === ops.pmRole && r.agent === false) ? ' · pm 역할 agent:false는 더 쓰지 않음(무시됨)' : '';
  return result('config', '설정', 'ok', `${ops.project} · 역할 ${roles.length}개 · namespace ${ns}${pmOld}`);
}

// 이 PC의 다른 wy-ops 프로젝트와 겹침(D-39 ②): 메시지 가드는 역할 이름만 보고, 승인 폴더는 namespace로 나뉜다.
//   접두사(rolePrefix, 없으면 pmRole)가 같거나 한쪽이 다른 쪽 앞부분이면, namespace가 같으면 fail. 목록은 ~/.claude.json projects에서 찾는다(lib/projects.js)
function checkPrefix(o) {
  const TITLE = '다른 프로젝트와 이름 겹침';
  const { ops, error } = opsConfig(o);
  if (error) return result('prefix', TITLE, 'ok', '설정 없음(건너뜀)');
  const projects = require('./projects');
  const self = { rolePrefix: ops.rolePrefix, pmRole: ops.pmRole, namespace: ops.approvals && ops.approvals.namespace };
  const others = projects.others(o.repoRoot, o.home);
  const hits = projects.conflicts(self, others);
  if (!hits.length) return result('prefix', TITLE, 'ok', `접두사 ${self.rolePrefix || self.pmRole || '없음'} · 이 PC의 다른 프로젝트 ${others.length}곳과 겹치지 않음`);
  const what = hits.map((h) => `${h.why === 'prefix' ? '역할 접두사' : 'approvals.namespace'} ${h.value}(${h.project || path.basename(h.dir)}, ${slash(h.dir)})`).join(' · ');
  return result('prefix', TITLE, 'fail', `겹침: ${what} — 다른 프로젝트 세션에 메시지·승인이 섞일 수 있음`, '.claude/wy-ops.json의 rolePrefix(역할 이름 포함)나 approvals.namespace를 겹치지 않게 고친 뒤(사용자) gen');
}

// 커밋되는 설정 파일에 이 PC의 홈 경로가 들어가 있으면 다른 PC에서 깨진다(OPS-10-1)
function checkPersonalPaths(o) {
  const home = slash(o.home).replace(/\/+$/, '');
  if (!home) return result('paths-personal', '개인 경로', 'ok', '홈 경로를 모름(건너뜀)');
  const needles = [home, home.replace(/\//g, '\\'), home.replace(/\//g, '\\\\')].map((n) => n.toLowerCase());
  const files = [];
  const walk = (p) => {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    else if (st.size < 2 * 1024 * 1024) files.push(p);
  };
  const claude = path.join(o.repoRoot, '.claude');
  walk(path.join(claude, 'wy-ops.json'));
  for (const d of ['ops', 'agents', 'skills']) walk(path.join(claude, d));
  const hits = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      const l = line.toLowerCase();
      if (needles.some((n) => l.includes(n))) hits.push(`${slash(path.relative(o.repoRoot, f))}:${i + 1}`);
    });
  }
  if (hits.length) return result('paths-personal', '개인 경로', 'fail', `커밋되는 파일에 홈 경로(${home})가 있음: ${hits.slice(0, 8).join(', ')}${hits.length > 8 ? ` 외 ${hits.length - 8}곳` : ''}`, '해당 줄을 ~ 또는 상대 경로로 바꾸기');
  return result('paths-personal', '개인 경로', 'ok', `${files.length}개 파일에 홈 경로 없음`);
}

function checkGitignore(o) {
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(o.repoRoot, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  } catch {
    // 파일이 없으면 모두 빠진 것으로 본다
  }
  const norm = (l) => l.replace(/^\//, '').replace(/\/$/, '');
  const have = new Set(lines.map(norm));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(norm(l)));
  const level = missing.every((l) => GITIGNORE_WARN.includes(l)) ? 'warn' : 'fail';
  if (missing.length) return result('gitignore', '.gitignore', level, `빠진 줄: ${missing.join(', ')}(setup이 .bak-<시각>을, claude -w가 .claude/worktrees/를 만들기 때문에 필요)`, `.gitignore에 넣을 줄: ${missing.join(' ')}`);
  return result('gitignore', '.gitignore', 'ok', `${GITIGNORE_LINES.length}줄 모두 있음`);
}

// 공용 워킹트리(INS-03, D-14): 백그라운드 역할 세션이 공용 트리를 고치려면 .claude/settings.json에 worktree.bgIsolation이 있어야 한다.
// update는 이 커밋 파일을 고치지 않으므로 여기서 알린다(pm 결정). 역할 worktree(S4, wy-ops.json worktree)를 켠 프로젝트도 "none"이어야 한다:
// session.ps1이 작업 폴더로 worktree를 정하므로 Claude Code가 따로 격리하면 worktree 안에 worktree가 생긴다(설계 7절)
function checkBgIsolation(o) {
  const file = path.join(o.repoRoot, '.claude', 'settings.json');
  let s;
  try {
    s = readSettings(file);
  } catch (err) {
    return result('bg-isolation', '공용 워킹트리', 'warn', `${slash(file)}을 읽지 못함: ${err.message}`, 'JSON을 고친 뒤 worktree.bgIsolation을 "none"으로 넣음(사용자)');
  }
  const v = s.worktree && typeof s.worktree === 'object' ? s.worktree.bgIsolation : undefined;
  const c = opsConfig(o);
  const wtOn = !c.error && wt.isOn(c.ops);
  if (v !== undefined && wtOn && v !== 'none') return result('bg-isolation', '공용 워킹트리', 'warn', `worktree.bgIsolation=${v} — 역할 worktree를 켠 프로젝트라 Claude Code가 따로 격리하면 worktree가 겹침`, '.claude/settings.json의 worktree.bgIsolation을 "none"으로 바꿈(사용자)');
  if (v !== undefined) return result('bg-isolation', '공용 워킹트리', 'ok', `worktree.bgIsolation=${v}`);
  const init = initHint(c);
  return result('bg-isolation', '공용 워킹트리', 'warn', `.claude/settings.json에 worktree.bgIsolation 없음(${wtOn ? 'Claude Code가 백그라운드 세션을 따로 격리하면 역할 worktree와 겹침' : '백그라운드 역할 세션이 공용 워킹트리를 고치지 못함'})`,
    `${init} (있는 파일·값은 덮지 않고 이 값만 더함. 검증 명령(verify)이 없는 설정이면 그것도 더함) · 또는 .claude/settings.json에 "worktree": { "bgIsolation": "none" }을 손으로 넣음(사용자)`);
}

// 역할 worktree(S4, D-32 다): 켜진 프로젝트에서만 본다. 흔적·잠김·정리 대상과, 역할 worktree를 처음 만들기 전 본 워킹트리의 미커밋 파일을 알린다.
// 모두 주의(지우는 일은 안의 파일을 사람이 확인한 뒤). git은 읽기만 한다(--no-optional-locks: status가 index를 고쳐 쓰지 않게)
// 확장이 worktree 세션의 대화 기록을 읽는 패키지 최소 버전. dev1 3단계 커밋 뒤 pm이 정한다(null이면 보지 않음)
const WT_MIN_PACKAGE = null;
function checkWorktrees(o) {
  const c = opsConfig(o);
  if (c.error || !wt.isOn(c.ops)) return result('worktrees', '역할 worktree', 'ok', c.error ? '설정 없음' : '꺼짐(wy-ops.json worktree.enabled=false)');
  const git = (...a) => o.run('git', ['--no-optional-locks', '-C', o.repoRoot, ...a]);
  const lines = (r) => String(r.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const list = git('worktree', 'list', '--porcelain');
  if (list.status !== 0) return result('worktrees', '역할 worktree', 'warn', 'git worktree list를 실행하지 못함', 'git이 있는지, 이 폴더가 git 저장소인지 확인');
  // porcelain 블록: 'worktree <경로>' 다음 줄들에 'locked …'·'prunable …'
  const entries = String(list.stdout).split(/\r?\n\s*\r?\n/).map((b) => {
    const ls = b.split(/\r?\n/);
    const p = ls.find((l) => l.startsWith('worktree '));
    return p && { dir: path.resolve(p.slice(9)), locked: ls.some((l) => /^locked\b/.test(l)), prunable: ls.some((l) => /^prunable\b/.test(l)) };
  }).filter(Boolean);
  const key = (p) => lower(path.resolve(p));
  const wtRoot = path.join(o.repoRoot, '.claude', 'worktrees');
  const inside = entries.filter((e) => key(path.dirname(e.dir)) === key(wtRoot));
  const name = (e) => path.basename(e.dir);
  const roles = (c.ops.roles || []).map((r) => r && r.name).filter((n) => n && wt.isWtRole(c.ops, n));
  const roleWts = inside.filter((e) => roles.includes(name(e)));
  const issues = [];
  const fixes = [];
  const add = (items, what, fix) => {
    if (!items.length) return;
    issues.push(`${what}: ${items.join(', ')}`);
    fixes.push(fix);
  };
  let folders = [];
  try {
    folders = fs.readdirSync(wtRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // 폴더가 없으면 흔적도 없다
  }
  const listed = new Set(entries.map((e) => key(e.dir)));
  add(folders.filter((n) => !listed.has(key(path.join(wtRoot, n)))), 'git worktree 목록에 없는 흔적 폴더', '.claude/worktrees/ 아래 그 폴더의 파일을 확인해 옮기거나 지움(사용자)');
  add(inside.filter((e) => !roles.includes(name(e))).map(name), '역할이 아닌 worktree(claude -w 등)', '안 쓰면 커밋하지 않은 변경을 확인한 뒤 git worktree remove <경로>');
  add(entries.filter((e) => e.locked).map((e) => slash(e.dir)), '잠긴 worktree', '쓰는 세션이 없으면 git worktree unlock <경로>');
  add(entries.filter((e) => e.prunable).map((e) => slash(e.dir)), '폴더 없는 등록', 'git worktree prune');
  // worktree.roles에 역할 목록에 없는 이름(오타)이나 pm·commit이 있으면 문구(본 저장소 역할)와 session.ps1 동작이 어긋난다
  const known = (c.ops.roles || []).map((r) => r && r.name);
  const wtRoles = [].concat((c.ops.worktree && c.ops.worktree.roles) || []);
  add(wtRoles.filter((n) => !known.includes(n) || n === c.ops.pmRole || n === c.ops.commitRole), 'worktree.roles에 역할이 아니거나 pm·commit인 이름', 'wy-ops.json worktree.roles를 역할 목록(roles)의 pm·commit이 아닌 이름으로 고친 뒤 install.ps1 gen(사용자)');
  const br = git('branch', '--list', 'worktree-*', '--format=%(refname:short)');
  add(br.status === 0 ? lines(br) : [], 'claude -w가 남긴 가지', `병합됐으면 ${c.ops.commitRole || '커밋 세션'}에 git branch -d 요청`);
  // D-32 다): 역할 worktree는 기준 가지의 커밋에서 만들어지므로, 처음 만들기 전의 미커밋 파일은 역할 세션에 보이지 않는다
  if (roles.length && !roleWts.length) {
    const st = git('status', '--porcelain', '--untracked-files=no'); // 추적하지 않는 파일(조사 문서 등)은 세지 않는다
    const n = st.status === 0 ? lines(st).length : 0;
    if (n) {
      issues.push(`역할 worktree를 아직 만들지 않았는데 본 워킹트리에 커밋하지 않은 변경 ${n}개(역할 worktree에는 따라가지 않음)`);
      fixes.push(`역할 세션을 처음 띄우기 전에 ${c.ops.commitRole || '커밋 세션'}로 커밋하거나 정리`);
    }
  }
  // 프로젝트 템플릿(.claude/ops/agent.md)을 따로 둔 프로젝트는 자리표시자가 없으면 worktree 규칙 문구가 역할 파일에 빠진다(gen-agents는 그대로 통과)
  // pm 역할 템플릿(.claude/ops/agent-pm.md, D-36)도 같다
  for (const name of ['agent.md', 'agent-pm.md']) {
    let agentTpl = null;
    try {
      agentTpl = fs.readFileSync(path.join(o.repoRoot, '.claude', 'ops', name), 'utf8');
    } catch {
      // 없으면 패키지 기본 템플릿을 쓴다(자리표시자 있음)
    }
    if (agentTpl !== null && !wt.hasTreeRules(agentTpl)) {
      issues.push(`.claude/ops/${name}에 {{treeRules}} 없음(역할 파일에 worktree 규칙 문구가 빠짐)`);
      fixes.push(`.claude/ops/${name}의 워킹트리 규칙 줄을 {{treeRules}}로 바꾼 뒤 install.ps1 gen(사용자)`);
    }
  }
  const d = WT_MIN_PACKAGE && readDeployed(o);
  if (d && d.version && versionBelow(d.version, WT_MIN_PACKAGE)) {
    issues.push(`설치본 ${d.version}이 ${WT_MIN_PACKAGE}보다 낮음(확장이 worktree 세션의 토큰·활동을 못 읽음)`);
    fixes.push('새 패키지를 배포(install.ps1 deploy)한 뒤 VS Code 창 다시 불러오기(사용자)');
  }
  if (!issues.length) return result('worktrees', '역할 worktree', 'ok', `켜짐 · 역할 worktree ${roleWts.length}/${roles.length}개 있음`);
  return result('worktrees', '역할 worktree', 'warn', issues.join(' · '), fixes.join(' · '));
}

// 자동 압축 안전망(TOK-1, D-20): 1M 문맥 모델은 기본으로 약 967K에서야 압축한다. .claude/settings.json의 autoCompactWindow를 본다.
// 환경 변수 CLAUDE_CODE_AUTO_COMPACT_WINDOW가 settings env에 있으면 그것이 우선이라 함께 적는다
function checkAutoCompact(o) {
  const file = path.join(o.repoRoot, '.claude', 'settings.json');
  let s;
  try {
    s = readSettings(file);
  } catch (err) {
    return result('auto-compact', '자동 압축 기준', 'warn', `${slash(file)}을 읽지 못함: ${err.message}`, 'JSON을 고친 뒤 "autoCompactWindow": 200000을 넣음(사용자)');
  }
  const env = s.env && typeof s.env === 'object' ? s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW : undefined;
  const envNote = env !== undefined ? ` · env CLAUDE_CODE_AUTO_COMPACT_WINDOW=${env}이 우선` : '';
  if (s.autoCompactWindow !== undefined) return result('auto-compact', '자동 압축 기준', 'ok', `autoCompactWindow=${s.autoCompactWindow}${envNote}`);
  const c = opsConfig(o);
  const init = initHint(c);
  return result('auto-compact', '자동 압축 기준', 'warn', `.claude/settings.json에 autoCompactWindow 없음(1M 문맥 모델은 약 967K에서야 자동 압축)${envNote}`,
    `${init} (있는 파일·값은 덮지 않고 빠진 값만 더함. 검증 명령(verify)이 없는 설정이면 그것도 더함) · 또는 .claude/settings.json에 "autoCompactWindow": 200000을 손으로 넣음(사용자)`);
}

// 플러그인 표준(SKL, D-22): .claude/settings.json enabledPlugins에 init이 넣는 표준 키(쓰지 않는 플러그인 끄기)가 있는지 본다.
// 사용자가 true로 바꾼 값도 '있음'으로 친다. update는 settings를 고치지 않으므로 init을 다시 돌리라고 안내한다
function checkPluginsStandard(o) {
  const c = opsConfig(o);
  const STANDARD_PLUGINS_OFF = require('./init').contextStandard(c.ops).pluginsOff;
  const file = path.join(o.repoRoot, '.claude', 'settings.json');
  let s;
  try {
    s = readSettings(file);
  } catch (err) {
    return result('plugins-standard', '플러그인 표준', 'warn', `${slash(file)}을 읽지 못함: ${err.message}`, `JSON을 고친 뒤 enabledPlugins에 ${STANDARD_PLUGINS_OFF.map((id) => `"${id}": false`).join(', ')}를 넣음(사용자)`);
  }
  const ep = s.enabledPlugins && typeof s.enabledPlugins === 'object' && !Array.isArray(s.enabledPlugins) ? s.enabledPlugins : {};
  const missing = STANDARD_PLUGINS_OFF.filter((id) => ep[id] === undefined);
  if (!missing.length) return result('plugins-standard', '플러그인 표준', 'ok', STANDARD_PLUGINS_OFF.map((id) => `${id}=${ep[id]}`).join(', '));
  const init = initHint(c);
  return result('plugins-standard', '플러그인 표준', 'warn', `.claude/settings.json enabledPlugins에 표준 값 없음: ${missing.join(', ')}(이 프로젝트에서 쓰지 않는 플러그인이 켜져 있음)`,
    `update 뒤에 ${init} (있는 파일·값은 덮지 않고 빠진 값만 더함. 검증 명령(verify)이 없는 설정이면 그것도 더함) · 또는 .claude/settings.json enabledPlugins에 ${missing.map((id) => `"${id}": false`).join(', ')}를 손으로 넣음(사용자)`);
}

// 시작 문맥 표준(TOK-4, D-22): .claude/settings.json에 init이 넣는 skillOverrides 키("off")와 disableClaudeAiConnectors가 있는지 본다.
// 사용자가 바꾼 값도 '있음'으로 친다
function checkContextStandard(o) {
  const c = opsConfig(o);
  const { skillsOff, screen, screenSkillsOff, screenPluginsOff } = require('./init').contextStandard(c.ops);
  const { isMap } = require('../gen-agents');
  const file = path.join(o.repoRoot, '.claude', 'settings.json');
  const want = `skillOverrides에 ${skillsOff.map((id) => `"${id}": "off"`).join(', ')}, "disableClaudeAiConnectors": true`;
  let s;
  try {
    s = readSettings(file);
  } catch (err) {
    return result('context-standard', '시작 문맥 표준', 'warn', `${slash(file)}을 읽지 못함: ${err.message}`, `JSON을 고친 뒤 ${want}를 넣음(사용자)`);
  }
  const so = isMap(s.skillOverrides) ? s.skillOverrides : {};
  const missing = skillsOff.filter((id) => so[id] === undefined);
  if (s.disableClaudeAiConnectors === undefined) missing.push('disableClaudeAiConnectors');
  // 화면 역할(frontend·design)을 나중에 더했는데 init 때 꺼 둔 화면용 스킬·플러그인이 그대로 꺼져 있으면 알린다(init은 빠진 값만 더함)
  const ep = isMap(s.enabledPlugins) ? s.enabledPlugins : {};
  const screenOff = screen ? [...screenSkillsOff.filter((id) => so[id] === 'off'), ...screenPluginsOff.filter((id) => ep[id] === false)] : [];
  if (screenOff.length) return result('context-standard', '시작 문맥 표준', 'warn', `화면 역할이 있는데 꺼져 있음: ${screenOff.join(', ')}`,
    `.claude/settings.json에서 skillOverrides의 그 키를 지우고 enabledPlugins의 그 값을 true로 바꿈(사용자)`);
  if (!missing.length) return result('context-standard', '시작 문맥 표준', 'ok', `skillOverrides ${skillsOff.length}개, disableClaudeAiConnectors=${s.disableClaudeAiConnectors}`);
  const init = initHint(c);
  return result('context-standard', '시작 문맥 표준', 'warn', `.claude/settings.json에 표준 값 없음: ${missing.join(', ')}(안 쓰는 스킬·claude.ai 커넥터가 시작 문맥에 실림)`,
    `update 뒤에 ${init} (있는 파일·값은 덮지 않고 빠진 값만 더함) · 또는 .claude/settings.json에 ${want}를 손으로 넣음(사용자)`);
}

// 확장 id가 wy-ops로 바뀐 뒤에는 VS Code 저장 상태가 새로 시작된다(R4, pm 결정: 알리기만)
function checkLedger(o) {
  const list = installedExtensions(o);
  if (list && list.some((e) => e.id === STUB_ID)) {
    return result('ledger', '출처 대조 원장', 'ok', '확장 id가 wy-ops로 바뀐 뒤에는 출처 대조 원장을 새로 시작합니다(그 시각 전의 결정은 신뢰). 확인함·접힘 같은 화면 상태도 처음부터입니다');
  }
  return result('ledger', '출처 대조 원장', 'ok', '확장 id 전환 전(해당 없음)');
}

// 비밀값 폴더는 있는지만 본다. 내용은 읽지 않는다. wy-ops.json secretsDir(없으면 점검하지 않음):
// 커밋되는 파일에 PC 절대 경로를 넣지 않도록 저장소 루트 기준 상대 경로를 쓰고(예 ../my-secrets), 배치가 다른 PC는 wy-ops.local.json으로 덮어쓴다
function secretsPath(o, value) {
  const v = String(value);
  if (/^~(?=$|[\\/])/.test(v)) return path.join(o.home, v.slice(1));
  return path.resolve(o.repoRoot, v);
}

function checkSecrets(o) {
  const { ops } = opsConfig(o);
  const dir = ops && ops.secretsDir ? secretsPath(o, ops.secretsDir) : null;
  if (!dir) return result('secrets', '비밀값 폴더', 'ok', 'wy-ops.json에 secretsDir가 없어 확인하지 않음');
  if (exists(dir)) {
    // 선택 설정 secretsKeys: 폴더 안 텍스트 파일에 'KEY=' 또는 'KEY:'로 시작하는 줄이 있는지만 본다. 값은 담아 두거나 출력하지 않는다
    const keys = Array.isArray(ops.secretsKeys) ? ops.secretsKeys.filter((k) => typeof k === 'string' && /^[A-Za-z0-9_.-]+$/.test(k)) : [];
    if (!keys.length) return result('secrets', '비밀값 폴더', 'ok', `${slash(dir)} 있음(내용은 읽지 않음)`);
    const found = new Set();
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9_.-]+)\s*[=:]/.exec(line);
        if (m && keys.includes(m[1])) found.add(m[1]);
      }
    }
    const missing = keys.filter((k) => !found.has(k));
    if (!missing.length) return result('secrets', '비밀값 폴더', 'ok', `${slash(dir)} 있음 · 키 ${keys.length}개 이름 확인(값은 출력하지 않음)`);
    return result('secrets', '비밀값 폴더', 'warn', `${slash(dir)}에 없는 키: ${missing.join(', ')}`, '원래 PC의 비밀값 파일을 손으로 다시 복사(값은 저장소·묶음에 넣지 않음)');
  }
  return result('secrets', '비밀값 폴더', 'warn', `${slash(dir)} 없음`, 'NEW-PC.md 비밀값 항목', {
    key: 'secrets',
    title: '비밀값 폴더 옮기기',
    what: `비밀값 폴더 ${slash(dir)}가 이 PC에 없습니다.`,
    why: '비밀값은 저장소에 없고 패키지도 옮기지 않습니다. 운영 확인(배포·메일 등)에 필요합니다.',
    steps: ['원래 PC의 비밀값 폴더를 안전한 방법(암호화된 USB·비밀번호 관리자 등)으로 옮깁니다', `이 PC의 ${slash(dir)}에 둡니다`, '메신저·메일·클라우드 공유로 보내지 않습니다'],
    check: 'install.ps1 doctor에서 비밀값 폴더가 ok로 보이면 됩니다.',
  });
}

function checkGithub(o) {
  const r = o.run('gh', ['auth', 'status']);
  if (r.status === 0) return result('login-github', 'GitHub 로그인', 'ok', 'gh auth status 통과');
  return result('login-github', 'GitHub 로그인', 'warn', r.status === null ? 'gh(GitHub CLI)가 없음' : 'gh 로그인 안 됨', 'gh auth login', {
    key: 'login-github',
    title: 'GitHub CLI 로그인',
    what: 'GitHub CLI(gh)에 로그인되어 있지 않습니다.',
    why: '커밋 세션이 PR·CI 확인에 gh를 씁니다.',
    steps: ['gh가 없으면 https://cli.github.com 에서 설치합니다', '터미널에서 `gh auth login`을 실행하고 안내를 따릅니다'],
    check: '`gh auth status`가 Logged in을 보이면 됩니다.',
  });
}

// 홈·저장소 경로에 공백·한글이 있으면 훅 명령이 깨지기 쉽다. 이때는 훅 스크립트를 문법 검사(node --check)만 한다(실행하지 않음)
function checkPathWarnings(o, template) {
  const odd = (p) => /\s|[^\x00-\x7f]/.test(p);
  const where = o.run('where', ['code']);
  const codePath = where.status === 0 ? String(where.stdout).split(/\r?\n/)[0].trim() : '';
  const codeKind = !codePath ? 'code 위치 모름' : /appdata[\\/]local[\\/]programs/i.test(codePath) ? `User 설치(${codePath})` : `System 설치(${codePath})`;
  const risky = [['홈', o.home], ['저장소', o.repoRoot]].filter(([, p]) => odd(p));
  if (!risky.length) return result('paths-warn', '경로 주의', 'ok', `공백·한글 없음 · VS Code ${codeKind}`);
  const hooksDir = path.join(o.toolsDir, 'current', 'vscode', 'hooks');
  const broken = template.hooks.map((t) => t.script).filter((s, i, a) => a.indexOf(s) === i).filter((s) => o.run('node', ['--check', path.join(hooksDir, s)]).status !== 0);
  return result('paths-warn', '경로 주의', 'warn', `${risky.map(([k, p]) => `${k} ${slash(p)}`).join(', ')}에 공백·한글이 있음${broken.length ? ` — 문법 검사 실패: ${broken.join(', ')}` : ' — 훅 스크립트 문법 검사 통과'} · VS Code ${codeKind}`, broken.length ? `${INSTALL} setup` : '');
}

// 원격 호스트(0.8.0 P5): sshd·방화벽 범위·Tailscale·전원·원격 창용 껍데기 확장. OpenSSH 서버가 없는 PC는 해당 없음(통과)
function checkHost(o) {
  let serverStub;
  try {
    const d = readDeployed(o);
    serverStub = require('./extensionTargets').serverStubState(o.home, d && d.stubHash);
  } catch {
    serverStub = undefined;
  }
  const r = require('./host').check(o.run, { platform: o.platform, serverStub });
  return result('host', '호스트', r.level, r.detail, r.level === 'ok' ? '' : `관리자 PowerShell에서 ${INSTALL} host (Tailscale은 할 일 카드대로)`);
}

function defaults(opts = {}) {
  const home = opts.home || os.homedir();
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  let approvalsRoot = opts.approvalsRoot;
  if (approvalsRoot === undefined) {
    try {
      approvalsRoot = require('../vscode/approvalStore').rootFor(repoRoot);
    } catch {
      approvalsRoot = null;
    }
  }
  return {
    repoRoot,
    home,
    toolsDir: opts.toolsDir || require('./deploy').toolsDir(),
    extensionsDir: opts.extensionsDir || null,
    approvalsRoot,
    settingsFile: opts.settingsFile || path.join(repoRoot, '.claude', 'settings.local.json'),
    run: opts.run || defaultRun,
    platform: opts.platform || process.platform,
  };
}

function checkAll(opts = {}) {
  const o = defaults(opts);
  let template;
  try {
    template = readJson(TEMPLATE);
  } catch (err) {
    return [result('template', '패키지', 'fail', `templates/settings.hooks.json을 읽지 못함: ${err.message}`, '저장소를 다시 받기')];
  }
  const checks = [
    () => checkTools(o),
    () => checkInstall(o),
    () => checkHooks(o, template),
    () => checkDeny(o, template),
    () => checkExtension(o),
    () => checkPlugins(o),
    () => checkExtras(o),
    () => checkApprovals(o),
    () => checkDevices(),
    () => checkConfig(o),
    () => checkPrefix(o),
    () => checkVersionPin(o),
    () => checkVerify(o),
    () => checkStackTools(o),
    () => checkLock(o),
    () => checkPersonalPaths(o),
    () => checkGitignore(o),
    () => checkBgIsolation(o),
    () => checkWorktrees(o),
    () => checkAutoCompact(o),
    () => checkPluginsStandard(o),
    () => checkContextStandard(o),
    () => checkLedger(o),
    () => checkSecrets(o),
    () => checkGithub(o),
    () => checkPathWarnings(o, template),
    () => checkHost(o),
  ];
  // 고치기 안내의 install.ps1 경로는 실제 설치본 위치(WY_TOOLS_DIR 등)를 따른다
  const install = `powershell -ExecutionPolicy Bypass -File "${path.join(o.toolsDir, 'current', 'install.ps1')}"`;
  const custom = path.resolve(o.toolsDir) !== path.join(os.homedir(), '.wy-tools', 'wy-ops');
  // 한 항목이 예외로 죽어도 나머지는 본다
  return checks.map((c, i) => {
    try {
      const r = c();
      return custom && r && r.fix ? { ...r, fix: r.fix.split(INSTALL).join(install) } : r;
    } catch (err) {
      return result(`check-${i}`, '점검 오류', 'fail', String(err && err.message ? err.message : err), '');
    }
  });
}

const RANK = { fail: 0, warn: 1, ok: 2 };
const MARK = { fail: '[실패]', warn: '[주의]', ok: '[ 통과 ]' };

function format(results) {
  const sorted = results.slice().sort((a, b) => RANK[a.level] - RANK[b.level]);
  const lines = sorted.map((r) => `${MARK[r.level]} ${r.title} — ${r.detail}${r.fix && r.level !== 'ok' ? `\n          고치기: ${r.fix}` : ''}`);
  const n = (l) => results.filter((r) => r.level === l).length;
  lines.push('', `실패 ${n('fail')} · 주의 ${n('warn')} · 통과 ${n('ok')}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { json: false, project: null, extensionsDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--extensions-dir') out.extensionsDir = argv[++i];
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  let repoRoot = a.project;
  if (!repoRoot) {
    const top = defaultRun('git', ['rev-parse', '--show-toplevel']);
    repoRoot = top.status === 0 ? String(top.stdout).trim() : process.cwd();
  }
  const results = checkAll({ repoRoot, extensionsDir: a.extensionsDir });
  process.stdout.write((a.json ? JSON.stringify(results, null, 2) : format(results)) + '\n');
  return results.some((r) => r.level === 'fail') ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { checkAll, format, defaults, defaultRun, toolCmds, stackToolFound, STUB_ID, OLD_EXT_ID, GITIGNORE_LINES };
