// install.js restore(카드 1020): 임시 홈 olduser에서 묶고, 사용자 이름이 다른 임시 홈 newuser로 복원한다(실제 홈·설치본은 건드리지 않음)
//   node tools/wy-ops/test/restore.test.js
// 확장·함께 까는 도구 설치는 건너뛴다(--skip-extension --skip-extras). 설치본은 임시 WY_TOOLS_DIR에 만든다
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rmTree } = require('../lib/fsx');
const { projectKey } = require('../lib/transfer');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-restore-'));
const put = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester', GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester' } });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
// restore의 global은 설치 원본(git 저장소) HEAD를 배포한다. 사본(git archive)에서도 돌도록 패키지 작업 사본을 임시 저장소로 커밋해 그 install.js를 쓴다
const pkgRepo = path.join(tmp, 'pkg');
const INSTALL = path.join(pkgRepo, 'lib', 'install.js');
const cli = (home, args, input = '') => {
  const env = { ...process.env, USERPROFILE: home, HOME: home, WY_TOOLS_DIR: path.join(tmp, 'tools') };
  delete env.WY_APPROVALS_DIR;
  const r = spawnSync(process.execPath, [INSTALL, ...args], { env, input, encoding: 'utf8', timeout: 180000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

try {
  fs.cpSync(path.join(__dirname, '..'), pkgRepo, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) });
  git(pkgRepo, ['init', '-q']);
  git(pkgRepo, ['add', '-A']);
  git(pkgRepo, ['commit', '-q', '-m', 'pkg']);
  const homeA = path.join(tmp, 'olduser');
  const homeB = path.join(tmp, 'newuser');
  // 원격 역할의 저장소(브랜치 demo-branch)와, 원래 PC에서 홈 아래에 clone한 프로젝트
  const origin = path.join(tmp, 'origin');
  fs.mkdirSync(origin);
  git(origin, ['init', '-q', '-b', 'demo-branch']);
  put(path.join(origin, '.claude', 'wy-ops.json'), JSON.stringify({ project: 'demo', commitRole: 'DM-commit', pmRole: 'DM-pm', roles: [{ name: 'DM-pm' }], approvals: { namespace: 'demo' }, secretsDir: 'D:/demo-secrets' }));
  put(path.join(origin, 'README.md'), 'demo\n');
  git(origin, ['add', '-A']);
  git(origin, ['commit', '-q', '-m', 'init']);
  const projA = path.join(homeA, 'work', 'demo');
  fs.mkdirSync(path.dirname(projA), { recursive: true });
  assert.strictEqual(spawnSync('git', ['clone', '-q', origin, projA]).status, 0);
  put(path.join(homeA, '.claude', 'projects', projectKey(projA), 'memory', 'MEMORY.md'), '- 메모 하나\n');
  put(path.join(homeA, '.claude.json'), JSON.stringify({ mcpServers: { demo: { command: 'demo-mcp', env: { DEMO_TOKEN: 'placeholder-to-redact-1234567890' } } } }));
  const zip = path.join(tmp, 'move.zip');
  const ex = cli(homeA, ['export', '--project', projA, '--out', zip]);
  assert.strictEqual(ex.status, 0, ex.out);

  // 묻는 데서 아니오면 아무것도 하지 않음
  const no = cli(homeB, ['restore', zip, '--skip-extension', '--skip-extras'], 'n\n');
  assert.ok(no.out.includes('복원하지 않았습니다') && !fs.existsSync(path.join(homeB, 'work')), no.out);

  // 복원: 원래 홈 아래 경로는 새 홈 아래 같은 자리로, 브랜치도 그대로
  const projB = path.join(homeB, 'work', 'demo');
  const r = cli(homeB, ['restore', zip, '--yes', '--skip-extension', '--skip-extras']);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(r.out.includes(`프로젝트: ${projB}`), r.out);
  for (const step of ['[1/5]', '[2/5]', '[3/5]', '[4/5]', '[5/5]']) assert.ok(r.out.includes(step), `${step}\n${r.out}`);
  assert.strictEqual(git(projB, ['branch', '--show-current']), 'demo-branch', 'manifest의 브랜치로 clone');
  assert.strictEqual(fs.readFileSync(path.join(homeB, '.claude', 'projects', projectKey(projB), 'memory', 'MEMORY.md'), 'utf8'), '- 메모 하나\n', '메모리를 새 프로젝트 키로');
  assert.ok(fs.existsSync(path.join(projB, '.claude', 'settings.local.json')), 'setup이 훅 설정을 씀');
  assert.ok(fs.existsSync(path.join(tmp, 'tools', 'wy-ops', 'current')), '임시 설치본');
  const mcp = JSON.parse(fs.readFileSync(path.join(homeB, '.claude.json'), 'utf8')).mcpServers.demo;
  assert.ok(mcp && mcp.command === 'demo-mcp' && mcp.env.DEMO_TOKEN !== 'placeholder-to-redact-1234567890', 'MCP는 병합하되 토큰은 자리표시');
  const todo = r.out.slice(r.out.indexOf('[5/5]'));
  assert.ok(todo.includes('비밀값 폴더(D:/demo-secrets)') && todo.includes('gh auth login') && todo.includes('DEMO_TOKEN'), todo);

  // 다시 돌리면 clone은 건너뜀
  const again = cli(homeB, ['restore', zip, '--yes', '--skip-extension', '--skip-extras']);
  assert.strictEqual(again.status, 0, again.out);
  assert.ok(again.out.includes('clone: 이미 있음'), again.out);

  // git 저장소가 아닌, 비어 있지 않은 폴더면 멈춤
  const other = path.join(tmp, 'other');
  put(path.join(other, 'x.txt'), 'x');
  const bad = cli(homeB, ['restore', zip, '--yes', '--skip-extension', '--skip-extras', '--project', other]);
  assert.notStrictEqual(bad.status, 0, bad.out);
  assert.ok(bad.out.includes('git 저장소가 아닙니다'), bad.out);
  console.log('restore 검사 통과');
} finally {
  rmTree(tmp);
}
