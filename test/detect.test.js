// 스택·검증 명령 알아내기(STK, lib/detect.js) + init의 verify 채우기 + verifyList 출력
//   node test/detect.test.js
// 모두 임시 폴더에서. 실제 홈·설치본·다른 프로젝트는 건드리지 않는다
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rmTree } = require('../lib/fsx');
const { detect, forProject, describe, verifyLines } = require('../lib/detect');
const { init } = require('../lib/init');
const { verifyList, VERIFY_KEYS } = require('../gen-agents');

const T = path.join(__dirname, '..', 'templates');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-detect-'));
let n = 0;
const proj = (files) => {
  const d = path.join(tmp, `p${n++}`);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    if (f.endsWith('/')) fs.mkdirSync(path.join(d, f), { recursive: true });
    else fs.writeFileSync(path.join(d, f), text);
  }
  return d;
};
const pkg = (scripts) => JSON.stringify({ name: 'x', scripts });
const nulls = (o, keys) => keys.every((k) => o[k] === null);

try {
  // 1. 판정
  let r = detect(proj({ 'package.json': pkg({ build: 'tsc', test: 'vitest' }) }), T);
  assert.deepStrictEqual(r.detected, [{ dir: '.', stack: 'node' }]);
  assert.deepStrictEqual([r.verify.build, r.verify.test], ['npm run build', 'npm test'], '루트 하나면 문자열');

  // 서버(gradle) + 화면(node) 하위 폴더 두 개: 맵, 도구 합집합, 메모에 폴더 이름
  r = detect(proj({ 'README.md': '', 'server/build.gradle': '', 'server/gradlew': '', 'web/package.json': pkg({ build: 'vite build', lint: 'eslint .', 'format:check': 'prettier -c .' }), 'web/package-lock.json': '{}' }), T);
  assert.deepStrictEqual(r.detected, [{ dir: 'server', stack: 'java-gradle' }, { dir: 'web', stack: 'node' }]);
  assert.deepStrictEqual(r.verify.build, { server: './gradlew compileJava compileTestJava --no-daemon', web: 'npm run build' }, JSON.stringify(r.verify));
  assert.deepStrictEqual(r.verify.test, { server: './gradlew test --no-daemon' }, 'web은 test 스크립트 없음');
  assert.deepStrictEqual([r.verify.setup, r.verify.lint, r.verify.format, r.verify.typecheck], [{ web: 'npm ci' }, { web: 'npm run lint' }, { web: 'npm run format:check' }, null]);
  assert.deepStrictEqual(r.tools.map((t) => t.cmd), ['java', 'node', 'npm']);
  assert.ok(r.stackNotes.length && r.stackNotes.every((x) => /^\((server|web)\/\) /.test(x)), r.stackNotes.join('\n'));

  // 루트가 gradle이면 gradle 하위 폴더(모듈)는 뺀다
  r = detect(proj({ 'settings.gradle.kts': '', 'app/build.gradle.kts': '', 'lib/build.gradle.kts': '' }), T);
  assert.deepStrictEqual(r.detected, [{ dir: '.', stack: 'java-gradle' }]);
  assert.strictEqual(r.verify.build, 'gradle compileJava compileTestJava --no-daemon', '래퍼(gradlew)가 없으면 gradle');
  assert.ok(r.stackNotes.length && r.stackNotes.every((x) => !x.includes('./gradlew')), `래퍼가 없으면 메모도 gradle: ${r.stackNotes.join(' / ')}`);

  // 루트 package.json(도구 전용) + frontend·backend package.json: node는 집계 빌드가 아니라 셋 다 잡는다
  r = detect(proj({ 'package.json': pkg({ prepare: 'husky' }), 'frontend/package.json': pkg({ build: 'vite build' }), 'backend/package.json': pkg({ test: 'jest' }) }), T);
  assert.deepStrictEqual(r.detected, [{ dir: '.', stack: 'node' }, { dir: 'backend', stack: 'node' }, { dir: 'frontend', stack: 'node' }]);
  assert.deepStrictEqual([r.verify.build, r.verify.test], [{ frontend: 'npm run build' }, { backend: 'npm test' }]);

  // 루트 node + 하위 python: 하위 폴더가 있으면 루트도 '.'으로 맵
  r = detect(proj({ 'package.json': pkg({ test: 'jest' }), 'ml/pyproject.toml': '[tool.pytest.ini_options]\n[tool.ruff]\n' }), T);
  assert.deepStrictEqual(r.detected, [{ dir: '.', stack: 'node' }, { dir: 'ml', stack: 'python' }]);
  assert.deepStrictEqual(r.verify.test, { '.': 'npm test', ml: 'python -m pytest -q' }, JSON.stringify(r.verify.test));
  assert.ok(r.verify.lint.ml && !r.verify.typecheck, 'ruff만 있음');
  assert.ok(r.stackNotes.some((x) => x.startsWith('(루트) ')), '루트 메모 접두사');

  // 제외 폴더·점 폴더, 빈 폴더, 없는 폴더
  r = detect(proj({ 'node_modules/a/package.json': '{}', 'docs/package.json': '{}', '.cache/package.json': '{}', 'build/pom.xml': '' }), T);
  assert.deepStrictEqual(r.detected, [], '제외 폴더는 보지 않음');
  for (const d of [proj({}), path.join(tmp, 'none')]) {
    r = detect(d, T);
    assert.ok(!r.detected.length && nulls(r.verify, VERIFY_KEYS.map(([k]) => k)) && !r.tools.length && !r.stackNotes.length, d);
  }

  // maven: 래퍼가 있으면 ./mvnw, 없으면 mvn. csharp·cpp는 템플릿 그대로
  assert.strictEqual(detect(proj({ 'pom.xml': '', mvnw: '' }), T).verify.test, './mvnw test -q');
  assert.strictEqual(detect(proj({ 'pom.xml': '' }), T).verify.test, 'mvn test -q');
  assert.deepStrictEqual(detect(proj({ 'App.SLN': '' }), T).detected, [{ dir: '.', stack: 'csharp' }], '대소문자 무시·* 표지');
  assert.deepStrictEqual(detect(proj({ 'CMakeLists.txt': '', 'package.json': '{}' }), T).detected, [{ dir: '.', stack: 'cpp' }], '빌드 도구가 먼저');

  // 2. node 다듬기: 없는 스크립트는 null, 'format'은 쓰지 않음, 기본 test 자리표시는 없음으로, 잠금 파일로 실행기
  const nv = (files) => detect(proj(files), T).verify;
  let v = nv({ 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1', format: 'prettier -w .' }) });
  assert.ok(v.setup === 'npm install' && nulls(v, ['build', 'test', 'typecheck', 'lint', 'format']), JSON.stringify(v));
  v = nv({ 'package.json': pkg({ 'type-check': 'tsc', 'check-format': 'x' }), 'tsconfig.json': '{}' });
  assert.deepStrictEqual([v.typecheck, v.format], ['npm run type-check', 'npm run check-format']);
  assert.strictEqual(nv({ 'package.json': '{}', 'tsconfig.json': '{}' }).typecheck, null, 'tsconfig만으로 채우지 않음');
  v = nv({ 'package.json': pkg({ build: 'b', test: 't' }), 'pnpm-lock.yaml': '' });
  assert.deepStrictEqual([v.setup, v.build, v.test], ['pnpm install --frozen-lockfile', 'pnpm run build', 'pnpm test']);
  r = detect(proj({ 'package.json': pkg({ lint: 'l' }), 'yarn.lock': '' }), T);
  assert.deepStrictEqual([r.verify.setup, r.verify.lint], ['yarn install --frozen-lockfile', 'yarn lint']);
  assert.deepStrictEqual(r.tools.map((t) => t.cmd), ['node', 'yarn'], '실행기에 맞춘 도구');
  assert.ok(nulls(nv({ 'package.json': '{ 깨진' }), ['build', 'test']), '깨진 package.json');
  assert.strictEqual(nv({ 'package.json': pkg({}), 'yarn.lock': '', '.yarnrc.yml': '' }).setup, 'yarn install --immutable', 'Yarn Berry');
  for (const lockFile of ['bun.lockb', 'bun.lock']) {
    v = nv({ 'package.json': pkg({ build: 'b', test: 't' }), [lockFile]: '' });
    assert.deepStrictEqual([v.setup, v.build, v.test], ['bun install --frozen-lockfile', 'bun run build', 'bun run test'], lockFile);
  }

  // 3. python: 설정 파일이 있는 도구만
  v = nv({ 'requirements.txt': '' });
  assert.ok(v.setup && nulls(v, ['build', 'test', 'typecheck', 'lint', 'format']), JSON.stringify(v));
  v = nv({ 'setup.py': '', 'tests/': '', 'mypy.ini': '' });
  assert.ok(!v.setup && v.test && v.typecheck && !v.lint, JSON.stringify(v));

  // 4. forProject·describe: 있는 verify는 그대로 보여 줌
  const P1 = proj({ 'package.json': pkg({ test: 't' }), '.claude/wy-ops.json': JSON.stringify({ stack: 'custom', verify: { test: 'make check' } }) });
  r = forProject(P1, T);
  assert.ok(r.existing && r.verify.test === 'make check' && r.detected[0].stack === 'custom', JSON.stringify(r));
  assert.ok(describe(r).includes('테스트: make check') && describe(r)[0].includes('있는 설정'), describe(r).join('\n'));
  const d0 = describe(forProject(proj({}), T));
  assert.ok(d0.includes('알아낸 폴더: 없음') && d0.some((l) => l.includes('찾지 못했습니다')), d0.join('\n'));

  // 5. verifyList: 문자열 verify는 예전 출력과 바이트까지 같다(이 저장소·쓰는 프로젝트의 생성물이 바뀌지 않게)
  const oldList = (ops) => {
    const vv = (ops && ops.verify) || {};
    const lines = VERIFY_KEYS.filter(([k]) => typeof vv[k] === 'string' && vv[k].trim()).map(([k, label]) => `- ${label}: \`${vv[k].trim()}\``);
    if (!lines.length) lines.push('- (아직 정하지 않았다. `.claude/wy-ops.json`의 `verify`에 setup·build·test·typecheck·lint·format 명령을 적는다)');
    for (const x of Array.isArray(ops && ops.stackNotes) ? ops.stackNotes : []) if (typeof x === 'string' && x.trim()) lines.push(`- ${x.trim()}`);
    return lines.join('\n');
  };
  for (const ops of [{}, { verify: null }, { verify: { test: ' npm test ', build: '', lint: null } }, { verify: { setup: 'a', format: 'b' }, stackNotes: ['메모', ' '] }]) assert.strictEqual(verifyList(ops), oldList(ops), JSON.stringify(ops));
  assert.strictEqual(verifyList({ verify: { build: { server: './gradlew build', 'web/': 'npm run build' }, test: 'npm test', lint: { web: ' ' } } }), [
    '- 폴더가 붙은 명령은 그 폴더에서 돌리고, 바뀐 폴더의 것만 돌린다.',
    '- 빌드: `./gradlew build` (server/) · `npm run build` (web/)',
    '- 테스트: `npm test`',
  ].join('\n'));
  assert.strictEqual(verifyList({ verify: { test: { '.': 'x' } } }), '- 폴더가 붙은 명령은 그 폴더에서 돌리고, 바뀐 폴더의 것만 돌린다.\n- 테스트: `x` (루트)');
  assert.strictEqual(verifyList({ verify: { test: { web: '' } } }), oldList({}), '빈 맵은 정하지 않음과 같음');

  // 6. init: 새 설정은 detected(stack 없음), --stack은 예전처럼, 있는 설정은 verify가 없을 때만 채움(.bak), 있으면 바이트 그대로
  const P2 = proj({ 'server/build.gradle': '', 'web/package.json': pkg({ build: 'b' }) });
  init({ project: P2, name: 'demo', prefix: 'AB-', templatesDir: T });
  const read = (p) => JSON.parse(fs.readFileSync(path.join(p, '.claude', 'wy-ops.json'), 'utf8'));
  let ops = read(P2);
  assert.ok(ops.stack === undefined && ops.detected.length === 2 && ops.verify.build.web === 'npm run build', JSON.stringify(ops));
  assert.ok(fs.readFileSync(path.join(P2, '.claude', 'ops', 'CLAUDE.part.md'), 'utf8').includes('`npm run build` (web/)'), 'CLAUDE 절에 폴더별 명령');

  const P3 = proj({ 'package.json': pkg({ test: 't' }) });
  init({ project: P3, name: 'demo', prefix: 'AB-', stack: 'node', verify: { lint: 'eslint' }, templatesDir: T });
  ops = read(P3);
  assert.ok(ops.stack === 'node' && !ops.detected && ops.verify.typecheck === 'npx tsc --noEmit' && ops.verify.lint === 'eslint', '--stack은 템플릿 값 그대로 + 덮어쓰기');

  // 부른 쪽이 넘긴 판정 결과(detection)를 그대로 쓴다(폴더를 다시 훑지 않음)
  const P6 = proj({ 'package.json': pkg({ test: 't' }) });
  init({ project: P6, name: 'demo', prefix: 'AB-', templatesDir: T, detection: { detected: [{ dir: '.', stack: 'python' }], verify: { test: 'given' }, tools: [], stackNotes: [] } });
  ops = read(P6);
  assert.ok(ops.detected[0].stack === 'python' && ops.verify.test === 'given', JSON.stringify(ops));

  // 있는 설정: 한 번 만든 뒤 verify 쪽 키를 지운 것(옛 설정)과, verify가 있는 것
  const cfgOf = (p) => path.join(p, '.claude', 'wy-ops.json');
  const P4 = proj({ 'package.json': pkg({ test: 't' }) });
  init({ project: P4, name: 'demo', prefix: 'AB-', templatesDir: T });
  const { verify: _v, detected: _d, tools: _t, stackNotes: _n, ...old } = read(P4);
  fs.writeFileSync(cfgOf(P4), JSON.stringify({ ...old, mine: 1 }, null, 2));
  r = init({ project: P4, name: 'demo', prefix: 'AB-', templatesDir: T });
  ops = read(P4);
  assert.ok(ops.mine === 1 && ops.verify.test === 'npm test' && ops.detected[0].stack === 'node' && Array.isArray(ops.tools), JSON.stringify(ops));
  assert.ok(r.files.some((f) => f.action === 'filled'), 'filled');
  assert.ok(fs.readdirSync(path.join(P4, '.claude')).some((f) => f.startsWith('wy-ops.json.bak-')), '.bak');

  const text = JSON.stringify({ ...old, verify: { test: null } });
  const P5 = proj({ 'package.json': pkg({ test: 't' }), '.claude/wy-ops.json': text });
  r = init({ project: P5, name: 'demo', prefix: 'AB-', templatesDir: T });
  assert.strictEqual(fs.readFileSync(path.join(P5, '.claude', 'wy-ops.json'), 'utf8'), text, 'verify가 있으면 바이트 그대로');
  assert.ok(r.files.some((f) => f.action === 'unmanaged'));

  // 7. CLI: install.js detect (읽기만, 설치본 없이 돈다)
  const cli = (args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'install.js'), 'detect', ...args], { encoding: 'utf8', env: { ...process.env, WY_TOOLS_DIR: path.join(tmp, 'tools') } });
  let c = cli(['--project', P2, '--json']);
  assert.strictEqual(c.status, 0, c.stderr);
  assert.deepStrictEqual(JSON.parse(c.stdout).verify.build, { server: 'gradle compileJava compileTestJava --no-daemon', web: 'npm run build' });
  c = cli(['--project', proj({ 'pom.xml': '' })]);
  assert.ok(c.status === 0 && c.stdout.includes('java-maven') && c.stdout.includes('mvn test -q'), c.stdout + c.stderr);

  // 8. detect --apply: 빈 폴더 init 뒤 코드가 생기면 다시 판정해 쓴다(.bak, 옛 stack 지움, 다른 키 그대로). 알아낸 것이 없으면 바이트 그대로
  const P7 = proj({});
  init({ project: P7, name: 'demo', prefix: 'AB-', templatesDir: T });
  const empty = read(P7);
  assert.ok(empty.detected.length === 0 && !verifyLines(empty.verify).length, JSON.stringify(empty));
  const before = fs.readFileSync(cfgOf(P7), 'utf8');
  c = cli(['--apply', '--project', P7]);
  assert.ok(c.status === 0 && c.stdout.includes('알아낸 것이 없어 설정을 바꾸지 않았습니다'), c.stdout + c.stderr);
  assert.strictEqual(fs.readFileSync(cfgOf(P7), 'utf8'), before, '알아낸 것이 없으면 바이트 그대로');
  assert.ok(!fs.readdirSync(path.join(P7, '.claude')).some((f) => f.includes('.bak-')), '.bak 없음');
  fs.writeFileSync(cfgOf(P7), JSON.stringify({ ...empty, stack: 'custom', verify: { test: 'old' }, mine: 1 }, null, 2));
  fs.writeFileSync(path.join(P7, 'package.json'), pkg({ build: 'tsc', test: 'vitest' }));
  c = cli(['--apply', '--project', P7]);
  assert.strictEqual(c.status, 0, c.stderr);
  ops = read(P7);
  assert.ok(ops.verify.build === 'npm run build' && ops.verify.test === 'npm test' && ops.detected[0].stack === 'node' && ops.tools.length, JSON.stringify(ops));
  assert.ok(ops.stack === undefined, '옛 stack 키 지움');
  assert.ok(ops.mine === 1 && JSON.stringify(ops.roles) === JSON.stringify(empty.roles) && ops.project === 'demo', '다른 키 그대로');
  assert.ok(fs.readdirSync(path.join(P7, '.claude')).some((f) => f.startsWith('wy-ops.json.bak-')), '.bak');
  assert.ok(c.stdout.includes('테스트: old') && c.stdout.includes('테스트: npm test') && c.stdout.includes('.bak-') && c.stdout.includes('- 테스트: `npm test`') && c.stdout.trim().endsWith('install.ps1 gen'), c.stdout);
  const after = fs.readFileSync(cfgOf(P7), 'utf8');
  const baks = () => fs.readdirSync(path.join(P7, '.claude')).filter((f) => f.includes('.bak-')).length;
  const nBak = baks();
  c = cli(['--apply', '--project', P7]);
  assert.ok(c.status === 0 && c.stdout.includes('이미 폴더와 같아'), c.stdout);
  assert.ok(fs.readFileSync(cfgOf(P7), 'utf8') === after && baks() === nBak, '이미 같으면 다시 쓰지 않음');
  c = cli(['--apply', '--project', proj({ 'package.json': '{}' })]);
  assert.ok(c.status === 1 && c.stdout.includes('install.ps1 init'), '설정이 없으면 init 안내');
  console.log('detect 검사 통과');
} finally {
  rmTree(tmp);
}
