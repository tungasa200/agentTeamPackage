// session.ps1 worktree(WT-01·D-31·D-32, S4): 켜져 있으면(키가 없으면 켬, 명시한 false가 우선) 역할 세션을 .claude/worktrees/<역할>(가지 wt/<역할>)에서 띄우고,
// 띄울 때마다 기준 가지로 빨리감기·settings.local.json 복사·deps 폴더 npm ci, 대화 기록은 세션 cwd 키로 찾고, wt-clean은 깨끗할 때만 지운다
//   node test/sessionWorktree.test.js   임시 저장소(실제 git)·가짜 claude·가짜 npm(PATH 앞 .cmd)·임시 USERPROFILE만
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rmTree } = require('../lib/fsx');

const PKG = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-wt-'));
try {
  const repo = path.join(tmp, 'repo');
  const scripts = path.join(repo, '.claude', 'skills', 'pm-ops', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(path.join(PKG, 'templates', 'pm-ops', 'scripts', 'session.ps1'), path.join(scripts, 'session.ps1'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
    return r.stdout.trim();
  };
  const ops = (worktree) => fs.writeFileSync(path.join(repo, '.claude', 'wy-ops.json'), JSON.stringify({
    rolePrefix: 'AB-', pmRole: 'AB-pm', commitRole: 'AB-commit',
    roles: [{ name: 'AB-commit', agent: true }, { name: 'AB-pm', agent: false }, { name: 'AB-qa', agent: true }, { name: 'AB-dev', agent: true }],
    ...(worktree ? { worktree } : {}),
  }));
  ops(null);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.local.json\n.claude/wy-ops.local.json\n.claude/worktrees/\nnode_modules/\n');
  fs.mkdirSync(path.join(repo, 'web'));
  fs.writeFileSync(path.join(repo, 'web', 'package-lock.json'), '{}');
  git(tmp, 'init', '-q', '-b', 'main', repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  // 승인 가드 훅이 있는 settings.local.json(setup이 넣는 모양: command 'node' + args). v로 복사본이 최신인지 본다
  const local = (v) => JSON.stringify({ v, hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node', args: ['C:/x/wy-approval-guard.js'] }] }] } });
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), local(1));

  // 가짜 claude: 받은 인자와 작업 폴더를 출력. 가짜 npm: 설치 표시(node_modules/.package-lock.json)를 남긴다
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const agents = path.join(tmp, 'agents.json');
  fs.writeFileSync(path.join(bin, 'claude.cmd'), [
    '@echo off',
    `if "%1"=="agents" type "${agents}" & exit /b 0`,
    'if "%1"=="stop" echo STOP %2 & exit /b 0',
    'if "%1"=="rm" echo RM %2 & exit /b 0',
    'if "%1"=="--bg" echo BG %* & echo CWD=%CD% & exit /b 0',
    'echo UNEXPECTED %* & exit /b 1',
  ].join('\r\n'));
  fs.writeFileSync(path.join(bin, 'npm.cmd'), [
    '@echo off',
    'echo NPM %* in %CD%',
    'if defined FAKE_NPM_FAIL exit /b 1',
    'if not exist node_modules mkdir node_modules',
    'echo {}> node_modules\\.package-lock.json',
  ].join('\r\n'));
  const lock = path.join(tmp, 'daemon.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const ps = (args, env = {}) => {
    const cmd = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; & '${path.join(scripts, 'session.ps1')}' ${args.join(' ')}`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: { ...process.env, ...gitEnv, PATH: bin + path.delimiter + process.env.PATH, USERPROFILE: home, WY_OPS_DAEMON_LOCK: lock, WY_OPS_DAEMON_TASK: 'wy-ops-test-no-such-task', WY_OPS_DAEMON_NAME: path.basename(process.execPath), WY_OPS_FREE_MB: '99999', ...env },
    });
    return (r.stdout || '') + (r.stderr || '');
  };
  const sessions = (list) => fs.writeFileSync(agents, JSON.stringify(list));
  const cwdOf = (out) => ((out.match(/CWD=(.*)/) || [])[1] || '').trim().toLowerCase();
  const wt = (role) => path.join(repo, '.claude', 'worktrees', role);
  sessions([]);

  // 1. 명시한 enabled:false는 기본값(켬, D-32)보다 우선: 저장소에서 띄우고 worktree를 만들지 않음
  ops({ enabled: false, deps: { 'AB-qa': ['web'] } });
  let out = ps(['start', 'AB-qa']);
  assert.ok(/BG --bg --agent AB-qa/.test(out) && cwdOf(out) === repo.toLowerCase() && !/NPM/.test(out), `enabled:false: 저장소에서\n${out}`);
  assert.ok(!fs.existsSync(path.join(repo, '.claude', 'worktrees')), `enabled:false: worktree 없음\n${out}`);

  // 2. 켜짐(enabled 없음 = 기본 켬): worktree·가지를 만들고, 설정 복사·deps 설치 뒤 worktree에서 띄움
  ops({ deps: { 'AB-qa': ['web'] } });
  fs.writeFileSync(path.join(repo, '.claude', 'wy-ops.local.json'), '{"memory":{}}');
  out = ps(['start', 'AB-qa']);
  assert.ok(/BG --bg --agent AB-qa/.test(out) && cwdOf(out) === wt('AB-qa').toLowerCase(), `켜짐: worktree에서\n${out}`);
  assert.strictEqual(git(wt('AB-qa'), 'branch', '--show-current'), 'wt/AB-qa', '가지 wt/<역할>');
  assert.strictEqual(fs.readFileSync(path.join(wt('AB-qa'), '.claude', 'settings.local.json'), 'utf8'), local(1), 'settings.local.json 복사');
  assert.ok(fs.existsSync(path.join(wt('AB-qa'), '.claude', 'wy-ops.local.json')), 'wy-ops.local.json 복사');
  assert.ok(new RegExp(`NPM ci --prefer-offline in ${wt('AB-qa').replace(/\\/g, '\\\\')}\\\\web`, 'i').test(out), `deps 폴더에서 npm ci\n${out}`);

  // 3. 다시 띄우면 재사용: 기준 가지로 빨리감기, 설정은 새로 복사, 설치 표시가 lock보다 새로우면 설치 안 함
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
  git(repo, 'add', 'new.txt');
  git(repo, 'commit', '-qm', 'new');
  fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), local(2));
  out = ps(['start', 'AB-qa']);
  assert.ok(cwdOf(out) === wt('AB-qa').toLowerCase() && !/실패|WARNING/.test(out), `재사용\n${out}`);
  assert.ok(fs.existsSync(path.join(wt('AB-qa'), 'new.txt')), `기준 가지로 빨리감기\n${out}`);
  assert.strictEqual(fs.readFileSync(path.join(wt('AB-qa'), '.claude', 'settings.local.json'), 'utf8'), local(2), '띄울 때마다 복사');
  assert.ok(!/NPM/.test(out), `설치돼 있으면 건너뜀\n${out}`);
  const lockFile = path.join(wt('AB-qa'), 'web', 'package-lock.json');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(lockFile, later, later);
  out = ps(['start', 'AB-qa']);
  assert.ok(/NPM ci/.test(out), `lock이 더 새로우면 다시 설치\n${out}`);
  fs.utimesSync(lockFile, later, new Date(Date.now() + 120000));
  out = ps(['start', 'AB-qa'], { FAKE_NPM_FAIL: '1' });
  assert.ok(/의존성 설치 실패/.test(out) && !/BG /.test(out), `설치 실패면 띄우지 않음\n${out}`);

  // 4. 갈라진 가지(병합 전 커밋 + 기준도 움직임): 빨리감기 실패는 경고만, 그대로 띄움
  fs.writeFileSync(path.join(wt('AB-qa'), 'qa.txt'), 'q');
  git(wt('AB-qa'), 'add', 'qa.txt');
  git(wt('AB-qa'), 'commit', '-qm', 'qa');
  fs.writeFileSync(path.join(repo, 'main2.txt'), 'm');
  git(repo, 'add', 'main2.txt');
  git(repo, 'commit', '-qm', 'main2');
  out = ps(['start', 'AB-qa']);
  assert.ok(/빨리감지 못했습니다/.test(out) && cwdOf(out) === wt('AB-qa').toLowerCase(), `갈라지면 경고하고 띄움\n${out}`);

  // 4-1. 승인 가드 훅이 없거나·settings.local.json이 없거나·복사가 실패하면 띄우지 않음(D-32)
  const localFile = path.join(repo, '.claude', 'settings.local.json');
  const dst = path.join(wt('AB-qa'), '.claude', 'settings.local.json');
  fs.writeFileSync(localFile, JSON.stringify({ v: 3, hooks: { Stop: [] } }));
  out = ps(['start', 'AB-qa']);
  assert.ok(/승인 가드 훅.*없어 띄우지 않습니다/.test(out) && !/BG /.test(out), `가드 훅 없음 → 거부\n${out}`);
  fs.unlinkSync(localFile);
  fs.unlinkSync(dst);
  out = ps(['start', 'AB-qa']);
  assert.ok(/본 저장소 \.claude\/settings\.local\.json이 없습니다.*install\.ps1 setup/.test(out) && !/승인 가드 훅/.test(out) && !/BG /.test(out), `settings.local.json 없음 → 원본 없음 안내\n${out}`);
  fs.writeFileSync(localFile, local(4));
  // 복사 대상 폴더(.claude) 자리에 파일을 두면 복사 실패(Copy-Item -Force는 읽기 전용도 덮어써서 그것으로는 못 냄)
  const wtClaude = path.join(wt('AB-qa'), '.claude');
  fs.renameSync(wtClaude, wtClaude + '.bak');
  fs.writeFileSync(wtClaude, '');
  out = ps(['start', 'AB-qa']);
  fs.unlinkSync(wtClaude);
  fs.renameSync(wtClaude + '.bak', wtClaude);
  assert.ok(/settings\.local\.json 를 복사하지 못해 띄우지 않습니다/.test(out) && !/BG /.test(out), `복사 실패 → 거부\n${out}`);
  // rotate는 작업 폴더 준비가 실패하면 이전 세션을 멈추거나 지우지 않음
  fs.writeFileSync(localFile, JSON.stringify({ v: 5 }));
  sessions([{ id: 'q0', name: 'AB-qa', kind: 'background', status: 'idle', pid: 5, startedAt: 1, sessionId: 'q0', cwd: wt('AB-qa') }]);
  out = ps(['rotate', 'AB-qa', 'none']);
  assert.ok(/승인 가드 훅/.test(out) && !/STOP|RM |BG /.test(out), `rotate: 준비 실패면 이전 세션 그대로\n${out}`);
  sessions([]);
  fs.writeFileSync(localFile, local(4));

  // 5. pm·commit은 늘 저장소. roles를 적으면 그 역할만
  out = ps(['start', 'AB-commit']);
  assert.ok(cwdOf(out) === repo.toLowerCase(), `commit은 저장소\n${out}`);
  ops({ roles: ['AB-dev'] });
  out = ps(['start', 'AB-qa']);
  assert.ok(cwdOf(out) === repo.toLowerCase(), `roles에 없으면 저장소\n${out}`);
  ops({});

  // 6. 대화 기록은 세션 cwd 키로: 멈춘 worktree 세션은 이어 띄우고(새로 띄우지 않음), health가 토큰을 읽음. resume도 worktree에서
  const key = (d) => path.join(home, '.claude', 'projects', d.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(key(wt('AB-qa')), { recursive: true });
  fs.writeFileSync(path.join(key(wt('AB-qa')), 'w1.jsonl'), JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 42000 } } }) + '\n');
  sessions([{ id: 'q1', name: 'AB-qa', kind: 'background', state: 'stopped', startedAt: 1, sessionId: 'w1', cwd: wt('AB-qa').replace(/\\/g, '/') }]);
  out = ps(['health']);
  assert.ok(/AB-qa\s+stopped\s+42/.test(out), `health: worktree 키에서 토큰\n${out}`);
  out = ps(['start', 'AB-qa', "'일'"]);
  assert.ok(/BG --bg --resume w1/.test(out) && cwdOf(out) === wt('AB-qa').toLowerCase(), `이어 띄우기, worktree에서\n${out}`);
  // 켜기 전 저장소에서 돈 세션(저장소 키)도 찾음
  fs.mkdirSync(key(repo), { recursive: true });
  fs.writeFileSync(path.join(key(repo), 'r1.jsonl'), '');
  sessions([{ id: 'q2', name: 'AB-qa', kind: 'background', state: 'stopped', startedAt: 1, sessionId: 'r1', cwd: repo }]);
  out = ps(['start', 'AB-qa', "'일'"]);
  assert.ok(/BG --bg --resume r1/.test(out) && cwdOf(out) === wt('AB-qa').toLowerCase(), `저장소 키 세션도 이어서, worktree로\n${out}`);
  sessions([]);

  // 7. 폴더는 있는데 git 목록에 없으면 멈춤(자동으로 지우지 않음)
  fs.mkdirSync(path.join(wt('AB-dev'), 'x'), { recursive: true });
  out = ps(['start', 'AB-dev']);
  assert.ok(/git worktree 목록에 없습니다/.test(out) && !/BG /.test(out), `흔적 폴더\n${out}`);
  out = ps(['wt-clean', 'AB-dev']);
  assert.ok(/폴더만 남음/.test(out) && fs.existsSync(wt('AB-dev')), `wt-clean도 흔적 폴더는 안 지움\n${out}`);
  rmTree(wt('AB-dev'));

  // 8. wt-clean: 실행 중·더러움·병합 안 된 커밋이면 멈춤, 깨끗하면 지우고 가지는 남김
  out = ps(['start', 'AB-dev']);
  assert.ok(cwdOf(out) === wt('AB-dev').toLowerCase(), `AB-dev worktree\n${out}`);
  sessions([{ id: 'd1', name: 'AB-dev', kind: 'background', status: 'idle', pid: 5, startedAt: 1, sessionId: 'd1', cwd: wt('AB-dev') }]);
  out = ps(['wt-clean', 'AB-dev']);
  assert.ok(/실행 중입니다/.test(out) && fs.existsSync(wt('AB-dev')), `실행 중이면 안 지움\n${out}`);
  sessions([]);
  fs.writeFileSync(path.join(wt('AB-dev'), 'wip.txt'), 'w');
  out = ps(['wt-clean', 'AB-dev']);
  assert.ok(/커밋하지 않은 변경 1개/.test(out) && /wip\.txt/.test(out) && fs.existsSync(wt('AB-dev')), `더러우면 안 지움\n${out}`);
  fs.unlinkSync(path.join(wt('AB-dev'), 'wip.txt'));
  out = ps(['wt-clean', 'AB-qa']);
  assert.ok(/병합 안 된 커밋 1개/.test(out) && fs.existsSync(wt('AB-qa')), `병합 안 된 커밋이면 안 지움\n${out}`);
  // 가지가 아니라 HEAD를 본다: detached에서 만든 커밋도 지키기
  git(wt('AB-dev'), 'checkout', '-q', '--detach');
  fs.writeFileSync(path.join(wt('AB-dev'), 'det.txt'), 'd');
  git(wt('AB-dev'), 'add', 'det.txt');
  git(wt('AB-dev'), 'commit', '-qm', 'det');
  out = ps(['wt-clean', 'AB-dev']);
  assert.ok(/병합 안 된 커밋 1개/.test(out) && fs.existsSync(wt('AB-dev')), `detached 커밋이면 안 지움\n${out}`);
  git(wt('AB-dev'), 'checkout', '-q', 'wt/AB-dev');
  out = ps(['wt-clean', 'AB-dev']);
  assert.ok(/worktree를 지웠습니다/.test(out) && !fs.existsSync(wt('AB-dev')), `깨끗하면 지움\n${out}`);
  assert.strictEqual(git(repo, 'branch', '--list', 'wt/AB-dev'), 'wt/AB-dev', '가지는 남김');
  // 남은 가지로 다시 띄우면 그 가지를 씀
  out = ps(['start', 'AB-dev']);
  assert.ok(cwdOf(out) === wt('AB-dev').toLowerCase() && git(wt('AB-dev'), 'branch', '--show-current') === 'wt/AB-dev', `있는 가지로 다시 만듦\n${out}`);
} finally {
  // worktree가 등록된 저장소도 폴더째 지운다(임시 폴더라 git 목록 정리는 필요 없음)
  rmTree(tmp);
}
console.log('sessionWorktree.test.js 통과');
