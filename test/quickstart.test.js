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

const VERIFY_NULL = ['build', 'test', 'typecheck', 'lint', 'format'];

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
  assert.strictEqual(qs.prefixFor('my-app', [{ rolePrefix: 'MY-' }]), 'MYA-', '다른 프로젝트와 겹치면 3자(D-39 ③)');
  const s = qs.summarize([{ level: 'ok', title: 'a' }, { level: 'warn', title: 'w', fix: 'gh auth login' }, { level: 'fail', title: 'f', detail: 'd' }]);
  assert.ok(s.startsWith('됐음: 점검 3개 중 1개') && s.indexOf('- f: d') < s.indexOf('- w') && s.includes('할 일: gh auth login'), s);
  assert.ok(qs.summarize([{ level: 'ok', title: 'a' }]).includes('남은 것 없음'));
  // 마침(0.10.0): pm은 로그인·신뢰가 끝난 사람 설치에서만, VS Code는 사람 설치이고 확장을 건너뛰지 않을 때
  const fp = (o) => qs.finishPlan({ interactive: true, skipExtension: false, loggedIn: true, trusted: true, ...o });
  assert.deepStrictEqual(fp({}), { openCode: true, startPm: true });
  assert.deepStrictEqual(fp({ loggedIn: false }), { openCode: true, startPm: false }, '로그인 전이면 pm 없이 VS Code만');
  assert.deepStrictEqual(fp({ trusted: false }), { openCode: true, startPm: false }, '신뢰 전이면 pm 없이');
  assert.deepStrictEqual(fp({ interactive: false }), { openCode: false, startPm: false }, '--yes는 둘 다 안 함');
  assert.deepStrictEqual(fp({ skipExtension: true }), { openCode: false, startPm: false }, '--skip-extension은 둘 다 안 함');

  // 2. CLI: 설치 원본은 git 저장소여야 하므로 패키지 작업 사본을 임시 저장소로 커밋해 그 install.js를 쓴다(restore.test.js와 같음)
  const pkgRepo = path.join(tmp, 'pkg');
  fs.cpSync(path.join(__dirname, '..'), pkgRepo, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)$/.test(src) });
  git(pkgRepo, ['init', '-q']);
  git(pkgRepo, ['add', '-A']);
  git(pkgRepo, ['commit', '-q', '-m', 'pkg']);
  const tools = path.join(tmp, 'tools');
  const cli = (args, cwd = tmp, { toolsDir = tools, installJs = path.join(pkgRepo, 'lib', 'install.js') } = {}) => {
    const env = { ...process.env, USERPROFILE: home, HOME: home, WY_TOOLS_DIR: toolsDir };
    delete env.WY_APPROVALS_DIR;
    const r = spawnSync(process.execPath, [installJs, 'quickstart', '--yes', '--skip-extension', '--skip-extras', ...args], { cwd, env, encoding: 'utf8', timeout: 300000 });
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
  assert.deepStrictEqual([ops.project, ops.rolePrefix, ops.stack, ops.detected], ['my-app', 'MY-', undefined, [{ dir: '.', stack: 'node' }]], r1.out);
  assert.strictEqual(ops.verify.setup, 'npm install', 'scripts가 없으면 설치 명령만');
  assert.ok(ops.worktree === undefined && r1.out.includes('역할 worktree 켬'), '고르지 않으면 적지 않음(키 없음 = 켬)');
  assert.ok(VERIFY_NULL.every((k) => ops.verify[k] === null), JSON.stringify(ops.verify));
  const cmd = fs.readFileSync(path.join(P, 'CLAUDE.md'), 'utf8');
  assert.ok(cmd.startsWith('# my-app\n') && cmd.includes(qs.SECTION_MARK) && cmd.includes('맨 위 `MY-pm` 줄(백그라운드 `MY-pm`'), cmd.slice(0, 400));
  assert.ok(fs.existsSync(path.join(P, '.claude', 'settings.local.json')), '새 settings는 묻지 않고 만듦');
  assert.ok(r1.out.includes('됐음: 점검') && r1.out.includes('--yes라 건너뜀'), r1.out);
  assert.ok(!r1.out.includes('pm 시작') && !r1.out.includes('pm은 띄우지 않았습니다'), `--yes는 pm을 띄우지 않음\n${r1.out}`);
  assert.ok([0, 1].includes(r1.status), r1.out); // 임시 홈이라 doctor FAIL(확장 없음 등)은 있을 수 있다
  assert.ok(r1.out.includes('설치본: ') && fs.existsSync(path.join(tools, 'wy-ops', 'current', 'deployed.json')), `설치본이 없으면 배포
${r1.out}`);
  const deployed = () => fs.readFileSync(path.join(tools, 'wy-ops', 'current', 'deployed.json'), 'utf8');
  const dep1 = deployed();

  // 2-2. 다시 돌리면: 있는 설정·CLAUDE.md 그대로, git 있음
  const before = fs.readFileSync(path.join(P, 'CLAUDE.md'), 'utf8');
  const r2 = cli(['--progress'], P);
  // INS-01: 설치본이 있으면 다시 배포하지 않는다(같은 커밋이면 안내 없음), 마법사 줄은 '이미 있음'(@@step global have)
  assert.ok(r2.out.includes('그대로 씁니다(다시 설치하지 않음)') && !r2.out.includes('install.ps1 deploy') && r2.out.includes('@@step global have') && !r2.out.includes('@@step global done'), r2.out);
  assert.strictEqual(deployed(), dep1, '설치본 그대로');
  assert.ok(r2.out.includes('git 저장소: 있음') && r2.out.includes('이미 있습니다(그대로 둠)') && r2.out.includes('있는 설정 그대로'), r2.out);
  assert.strictEqual(fs.readFileSync(path.join(P, 'CLAUDE.md'), 'utf8'), before);

  // 2-2b. clone이 설치본보다 새로우면 init 앞에서 경고만(설치본은 그대로, pm 결정 #1 (b) 2026-10-20)
  put(path.join(pkgRepo, 'new.txt'), 'x');
  git(pkgRepo, ['add', '-A']);
  git(pkgRepo, ['commit', '-q', '-m', 'next']);
  const r2b = cli([], P);
  const warn = r2b.out.indexOf('새 clone(v');
  assert.ok(r2b.out.includes(`커밋 ${git(pkgRepo, ['rev-parse', '--short', 'HEAD'])})입니다. 훅·생성물이 어긋날 수 있으니 install.ps1 deploy 뒤 다시 실행하세요`), r2b.out);
  assert.ok(warn > r2b.out.indexOf('[3/6]') && warn < r2b.out.indexOf('[4/6]'), `경고는 init(3단계) 앞\n${r2b.out}`);
  assert.strictEqual(deployed(), dep1, '새 clone이어도 다시 배포하지 않음');
  // 2-2c. 설치본의 install.js로 부르고 설치 원본(clone)이 없어도 실패하지 않는다
  const moved = `${pkgRepo}-moved`;
  fs.renameSync(pkgRepo, moved);
  try {
    const r2c = cli([], P, { installJs: path.join(tools, 'wy-ops', 'current', 'lib', 'install.js') });
    assert.ok(r2c.out.includes('그대로 씁니다') && r2c.out.includes('[6/6]') && !r2c.out.includes('설치 원본(패키지 저장소 clone)을 찾지 못했습니다'), r2c.out);
  } finally {
    fs.renameSync(moved, pkgRepo);
  }

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
  const r5 = cli(['--project', W, '--progress', '--no-finish', '--no-worktree'], tmp, { toolsDir: path.join(tmp, 'tools2') }); // 새 설치본 폴더: 배포(global done) // 마법사는 체크 상자를 끄면 --no-worktree를 넘긴다(INS-04)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(W, '.claude', 'wy-ops.json'), 'utf8')).worktree, { enabled: false }, r5.out);
  assert.ok(r5.out.includes('역할 worktree 끔'), r5.out);
  const at = (s) => r5.out.indexOf(`@@${s}`);
  for (const s of ['step global start', 'step global done', 'step folder start', 'claudemd create', 'step folder done']) assert.ok(at(s) >= 0, `${s}\n${r5.out}`);
  assert.ok(at('step global done') < at('step folder start') && at('claudemd create') < at('step folder done'), r5.out);
  assert.ok(!r5.out.includes('[5/6]') && r5.out.includes('--no-finish'), r5.out);
  assert.strictEqual(r5.status, 0, r5.out);

  // 2-3c. 이 PC의 다른 wy-ops 프로젝트(~/.claude.json projects)와 접두사가 겹치면 3자로(D-39 ③), --prefix로 준 값이 겹치면 오류
  put(path.join(home, '.claude.json'), JSON.stringify({ projects: { [P.replace(/\\/g, '/')]: {}, [Q]: {} } }));
  const M = path.join(tmp, 'work', 'mystery');
  const r6 = cli(['--project', M, '--no-finish'], tmp);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(M, '.claude', 'wy-ops.json'), 'utf8')).rolePrefix, 'MYS-', r6.out);
  assert.ok(r6.out.includes('MY-는 이 PC의 다른 프로젝트와 겹쳐 MYS-로 정했습니다'), r6.out);
  const r7 = cli(['--project', path.join(tmp, 'work', 'clash'), '--prefix', 'ot-', '--no-finish'], tmp);
  assert.ok(r7.status !== 0 && r7.out.includes('역할 접두사 ot-가 이 PC의 다른 프로젝트 other') && !fs.existsSync(path.join(tmp, 'work', 'clash', '.claude')), r7.out);
  const r8 = cli(['--no-finish'], P);
  assert.ok(r8.out.includes('역할 접두사 MY-') && !r8.out.includes('겹쳐'), `자기 프로젝트는 겹침에서 뺌\n${r8.out}`);
  // 자동 후보(MY-·MYS-·MY2~9-)가 모두 겹치면 겹친 채 쓰지 않고 멈춤(--prefix로 고르게)
  const R = path.join(tmp, 'work', 'mine');
  put(path.join(R, '.claude', 'wy-ops.json'), JSON.stringify({ project: 'mine', pmRole: 'MY' }));
  put(path.join(home, '.claude.json'), JSON.stringify({ projects: { [P.replace(/\\/g, '/')]: {}, [Q]: {}, [R]: {} } }));
  const r9 = cli(['--project', path.join(tmp, 'work', 'mystery2'), '--no-finish'], tmp);
  assert.ok(r9.status !== 0 && r9.out.includes('역할 접두사 MY-가 이 PC의 다른 프로젝트') && !fs.existsSync(path.join(tmp, 'work', 'mystery2', '.claude')), r9.out);
  // 새 설정의 승인 namespace(= 프로젝트 이름)가 다른 프로젝트와 같으면 멈춤(pm 결정 #2 (a)). quickstart(폴더 이름 my-app)·init 둘 다
  const N = path.join(tmp, 'work2', 'my-app');
  const r10 = cli(['--project', N, '--prefix', 'ZZ-', '--no-finish'], tmp);
  assert.ok(r10.status !== 0 && r10.out.includes('프로젝트 이름 my-app이 이 PC의 다른 프로젝트') && r10.out.includes('승인 namespace my-app') && !fs.existsSync(path.join(N, '.claude')), r10.out);
  const ri = spawnSync(process.execPath, [path.join(pkgRepo, 'lib', 'install.js'), 'init', '--yes', '--skip-extras', '--name', 'MY-APP', '--prefix', 'ZZ-', '--project', N], { cwd: tmp, env: { ...process.env, USERPROFILE: home, HOME: home, WY_TOOLS_DIR: tools }, encoding: 'utf8' });
  assert.ok(ri.status !== 0 && `${ri.stdout}${ri.stderr}`.includes('승인 namespace my-app') && !fs.existsSync(path.join(N, '.claude')), `init도 대소문자 무시로 멈춤\n${ri.stdout}${ri.stderr}`);

  // 2-4. 패키지 폴더 안은 거부
  const r4 = cli(['--project', path.join(pkgRepo, 'x')]);
  assert.notStrictEqual(r4.status, 0);
  assert.ok(r4.out.includes('패키지 폴더'), r4.out);
  console.log('quickstart 검사 통과');
} finally {
  rmTree(tmp);
}
