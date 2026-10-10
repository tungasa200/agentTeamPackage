// quickstart(한 줄 설치) 검사: 판단 함수(lib/quickstart.js)와, 임시 홈·임시 설치본에서 --yes로 끝까지 돌리기
//   node test/quickstart.test.js
// 확장·함께 까는 도구 설치는 건너뛴다(--skip-extension --skip-extras). 실제 홈·설치본·다른 프로젝트는 건드리지 않는다
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rmTree } = require('../lib/fsx');
const qs = require('../lib/quickstart');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-qs-'));
const put = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const git = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't' } });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

try {
  // 1. 판단 함수
  const home = path.join(tmp, 'home');
  assert.strictEqual(qs.cleanPath('  "C:\\work\\my app"  ', home), path.resolve('C:\\work\\my app'), '따옴표·공백');
  assert.strictEqual(qs.cleanPath('~\\proj', home), path.join(home, 'proj'), '~');
  assert.strictEqual(qs.cleanPath('$env:USERPROFILE\\proj', home), path.join(home, 'proj'), '$env:USERPROFILE');
  assert.strictEqual(qs.cleanPath('%USERPROFILE%\\proj', home), path.join(home, 'proj'), '%USERPROFILE%');
  assert.strictEqual(qs.cleanPath('"  "', home), '', '빈 입력');
  assert.strictEqual(qs.defaultName('C:\\x\\my app'), 'my-app');
  assert.strictEqual(qs.defaultName('C:\\x\\한글'), null, '영문이 없으면 null');
  assert.strictEqual(qs.prefixFor('my-app'), 'MY-');
  assert.strictEqual(qs.prefixFor('x'), 'X-');
  const sd = (files) => {
    const d = fs.mkdtempSync(path.join(tmp, 'st-'));
    for (const f of files) put(path.join(d, f), '');
    return qs.detectStack(d);
  };
  assert.strictEqual(sd(['package.json']), 'node');
  assert.strictEqual(sd(['pyproject.toml']), 'python');
  assert.strictEqual(sd(['package.json', 'build.gradle.kts']), 'java-gradle', '빌드 도구가 먼저');
  assert.strictEqual(sd(['App.sln']), 'csharp');
  assert.strictEqual(sd(['CMakeLists.txt']), 'cpp');
  assert.strictEqual(sd(['README.md']), 'custom');
  assert.strictEqual(qs.detectStack(path.join(tmp, 'none')), 'custom', '없는 폴더');
  const s = qs.summarize([{ level: 'ok', title: 'a' }, { level: 'warn', title: 'w', fix: 'gh auth login' }, { level: 'fail', title: 'f', detail: 'd' }]);
  assert.ok(s.startsWith('됐음: 점검 3개 중 1개') && s.indexOf('- f: d') < s.indexOf('- w') && s.includes('할 일: gh auth login'), s);
  assert.ok(qs.summarize([{ level: 'ok', title: 'a' }]).includes('남은 것 없음'));

  // 2. CLI: 설치 원본은 git 저장소여야 하므로 패키지 작업 사본을 임시 저장소로 커밋해 그 install.js를 쓴다(restore.test.js와 같음)
  const pkgRepo = path.join(tmp, 'pkg');
  fs.cpSync(path.join(__dirname, '..'), pkgRepo, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) });
  git(pkgRepo, ['init', '-q']);
  git(pkgRepo, ['add', '-A']);
  git(pkgRepo, ['commit', '-q', '-m', 'pkg']);
  const cli = (args, cwd = tmp) => {
    const env = { ...process.env, USERPROFILE: home, HOME: home, WY_TOOLS_DIR: path.join(tmp, 'tools') };
    delete env.WY_APPROVALS_DIR;
    const r = spawnSync(process.execPath, [path.join(pkgRepo, 'lib', 'install.js'), 'quickstart', '--yes', '--skip-extension', '--skip-extras', ...args], { cwd, env, encoding: 'utf8', timeout: 300000 });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  fs.mkdirSync(home, { recursive: true });

  // 2-1. git 없는 새 폴더(package.json만): git init, 이름·접두사·스택 기본값, CLAUDE.md 생성, 6단계, 요약
  const P = path.join(tmp, 'work', 'my-app');
  put(path.join(P, 'package.json'), '{}\n');
  const r1 = cli(['--project', `"${P}"`]); // 따옴표째 붙여 넣은 경로
  for (const step of ['[1/6]', '[2/6]', '[3/6]', '[4/6]', '[5/6]', '[6/6]']) assert.ok(r1.out.includes(step), `${step}\n${r1.out}`);
  assert.ok(fs.existsSync(path.join(P, '.git')), 'git init');
  const ops = JSON.parse(fs.readFileSync(path.join(P, '.claude', 'wy-ops.json'), 'utf8'));
  assert.deepStrictEqual([ops.project, ops.rolePrefix, ops.stack], ['my-app', 'MY-', 'node'], r1.out);
  const cmd = fs.readFileSync(path.join(P, 'CLAUDE.md'), 'utf8');
  assert.ok(cmd.startsWith('# my-app\n') && cmd.includes(qs.SECTION_MARK) && cmd.includes('`MY-pm` 창과 승인 센터'), cmd.slice(0, 400));
  assert.ok(fs.existsSync(path.join(P, '.claude', 'settings.local.json')), '새 settings는 묻지 않고 만듦');
  assert.ok(r1.out.includes('됐음: 점검') && r1.out.includes('--yes라 건너뜀'), r1.out);
  assert.ok([0, 1].includes(r1.status), r1.out); // 임시 홈이라 doctor FAIL(확장 없음 등)은 있을 수 있다

  // 2-2. 다시 돌리면: 있는 설정·CLAUDE.md 그대로, git 있음
  const before = fs.readFileSync(path.join(P, 'CLAUDE.md'), 'utf8');
  const r2 = cli([], P);
  assert.ok(r2.out.includes('git 저장소: 있음') && r2.out.includes('이미 있습니다(그대로 둠)') && r2.out.includes('있는 설정 그대로'), r2.out);
  assert.strictEqual(fs.readFileSync(path.join(P, 'CLAUDE.md'), 'utf8'), before);

  // 2-3. 하위 폴더를 주면 저장소 맨 위로, CLAUDE.md가 있으면 고치지 않고 붙일 내용만
  const Q = path.join(tmp, 'work', 'other');
  put(path.join(Q, 'CLAUDE.md'), '# 내 규칙\n');
  put(path.join(Q, 'src', 'a.py'), '');
  git(Q, ['init', '-q']);
  const r3 = cli(['--project', path.join(Q, 'src')]);
  assert.ok(r3.out.includes('저장소 맨 위에 붙입니다') && fs.existsSync(path.join(Q, '.claude', 'wy-ops.json')), r3.out);
  assert.strictEqual(fs.readFileSync(path.join(Q, 'CLAUDE.md'), 'utf8'), '# 내 규칙\n', '있는 CLAUDE.md는 고치지 않음');
  assert.ok(r3.out.includes('붙여 넣으세요') && r3.out.includes(qs.SECTION_MARK), r3.out);

  // 2-3b. 설치 마법사용(--progress --no-finish): 진행 줄, 폴더 준비까지만(5·6단계는 마법사가 따로). --progress가 없으면 진행 줄 없음
  assert.ok(!r1.out.includes('@@'), '진행 줄은 --progress일 때만');
  const W = path.join(tmp, 'work', 'wiz');
  put(path.join(W, 'README.md'), '');
  const r5 = cli(['--project', W, '--progress', '--no-finish']);
  const at = (s) => r5.out.indexOf(`@@${s}`);
  for (const s of ['step global start', 'step global done', 'step folder start', 'claudemd create', 'step folder done']) assert.ok(at(s) >= 0, `${s}\n${r5.out}`);
  assert.ok(at('step global done') < at('step folder start') && at('claudemd create') < at('step folder done'), r5.out);
  assert.ok(!r5.out.includes('[5/6]') && r5.out.includes('--no-finish'), r5.out);
  assert.strictEqual(r5.status, 0, r5.out);

  // 2-4. 패키지 폴더 안은 거부
  const r4 = cli(['--project', path.join(pkgRepo, 'x')]);
  assert.notStrictEqual(r4.status, 0);
  assert.ok(r4.out.includes('패키지 폴더'), r4.out);
  console.log('quickstart 검사 통과');
} finally {
  rmTree(tmp);
}
