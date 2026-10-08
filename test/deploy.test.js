// R2 검사: 버전 설치·current 정션·회전·rollback, 껍데기 확장 폴더와 경로 바꾸기
//   node tools/wy-ops/test/deploy.test.js
// 임시 git 저장소에 작은 패키지를 커밋해 두고 그 HEAD에서 배포한다(실제 홈·설치본은 건드리지 않음)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmTree } = require('../lib/fsx');
const { execFileSync } = require('child_process');
const { deploy, deployDev, rollback, versions, currentTarget } = require('../lib/deploy');
const stub = require('../lib/stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-dep-'));
const repo = path.join(tmp, 'repo');
const pkg = path.join(repo, 'tools', 'wy-ops');
const dir = path.join(tmp, 'home', '.wy-tools', 'wy-ops');
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true });
  fs.writeFileSync(path.join(pkg, rel), text);
};
const commit = (msg) => {
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg);
  return g('rev-parse', '--short', 'HEAD').trim();
};

try {
  fs.mkdirSync(repo, { recursive: true });
  g('init', '-q');
  const vpkg = { name: 'x', publisher: 'p', version: '0.5.0', engines: { vscode: '^1.85.0' }, main: './extension.js', activationEvents: ['onStartupFinished'], contributes: { viewsContainers: { activitybar: [{ id: 'v', title: 'V', icon: 'media/icon.svg' }] } } };
  put('package.json', JSON.stringify({ name: 'wy-ops', version: '0.6.0' }));
  put('vscode/package.json', JSON.stringify(vpkg));
  put('vscode/media/icon.svg', '<svg/>');
  put('vscode/extension.js', "const vscode = require('vscode');\nexports.activate = (ctx) => ({ uri: ctx.extensionUri, abs: ctx.asAbsolutePath('media/x'), sub: ctx.subscriptions, api: vscode.marker });\n");
  put('vscode/test/a.test.js', 'x');
  put('lib/x.test.js', 'x');
  put('vscode/hooks/wy-approval-guard.js', '// hook');
  const c1 = commit('v1');

  // 1. 첫 배포: 버전 폴더·current·deployed.json, 테스트 제외, 껍데기 폴더
  const r1 = deploy({ dir, pkg });
  assert.strictEqual(r1.name, `0.6.0-${c1}`);
  assert.strictEqual(currentTarget(dir), r1.name);
  const cur = path.join(dir, 'current');
  assert.ok(fs.existsSync(path.join(cur, 'vscode', 'hooks', 'wy-approval-guard.js')), 'current로 훅에 닿음');
  assert.ok(!fs.existsSync(path.join(cur, 'vscode', 'test')) && !fs.existsSync(path.join(cur, 'lib', 'x.test.js')), '테스트는 설치하지 않음');
  const dep = JSON.parse(fs.readFileSync(path.join(cur, 'deployed.json'), 'utf8'));
  assert.deepStrictEqual([dep.version, dep.commit, dep.stubHash], ['0.6.0', c1, r1.stubHash]);
  const sp = JSON.parse(fs.readFileSync(path.join(cur, 'stub-ext', 'package.json'), 'utf8'));
  assert.deepStrictEqual([sp.name, sp.publisher, sp.main, sp.wyOpsStubHash], ['wy-ops', 'wy-ops', './stub.js', r1.stubHash], '껍데기 id·진입점·해시');
  assert.ok(fs.existsSync(path.join(cur, 'stub-ext', 'media', 'icon.svg')), 'contributes 아이콘 복사');
  assert.ok(r1.stubChanged, '처음에는 껍데기가 새것');

  // 2. 같은 HEAD로 다시: 같은 폴더, 껍데기 그대로
  const r2 = deploy({ dir, pkg });
  assert.strictEqual(r2.name, r1.name);
  assert.strictEqual(r2.stubChanged, false);

  // 3. 코드만 바꾼 커밋: 새 버전 폴더, 껍데기 해시 같음 / contributes를 바꾼 커밋: 해시 바뀜
  put('vscode/extension.js', fs.readFileSync(path.join(pkg, 'vscode/extension.js'), 'utf8') + '// v2\n');
  const c2 = commit('v2');
  const r3 = deploy({ dir, pkg });
  assert.strictEqual(r3.name, `0.6.0-${c2}`);
  assert.strictEqual(r3.stubChanged, false, '코드만 바뀌면 껍데기 재설치 불필요');
  put('vscode/package.json', JSON.stringify({ ...vpkg, activationEvents: ['onStartupFinished', 'onView:v'] }));
  commit('v3');
  const r4 = deploy({ dir, pkg });
  assert.ok(r4.stubChanged, 'contributes·activationEvents가 바뀌면 껍데기 재설치');

  // 4. 회전: 4개째에서 가장 오래된 것 정리, current 대상은 남김
  put('x.txt', '4');
  commit('v4');
  const r5 = deploy({ dir, pkg, keep: 3 });
  assert.strictEqual(versions(dir).length, 3);
  assert.deepStrictEqual(r5.removed, [r1.name]);

  // 5. rollback: 정션만 되돌리고, 폴더는 남는다
  const rb = rollback({ dir });
  assert.strictEqual(rb.from, r5.name);
  assert.strictEqual(currentTarget(dir), rb.to);
  assert.ok(fs.existsSync(path.join(dir, r5.name, 'deployed.json')), '되돌려도 새 버전 폴더는 남음');
  assert.throws(() => rollback({ dir, name: 'nope' }), /되돌릴 버전이 없습니다/);
  assert.ok(!fs.readdirSync(dir).some((n) => /current\.(new|old)$/.test(n)), '임시 정션이 남지 않음');

  // 6. 껍데기 activate: 경로 바꾸기·'vscode' 이어 주기(가짜 vscode)
  {
    const Module = require('module');
    const api = { marker: 'api', Uri: { file: (p) => ({ fsPath: p }) }, window: { showErrorMessage: (m) => (api.err = m) } };
    const load = Module._load;
    const stubDir = fs.realpathSync(path.join(dir, 'current', 'stub-ext'));
    Module._load = function (req, parent) {
      if (req === 'vscode' && parent && parent.filename.startsWith(stubDir)) return api;
      return load.apply(this, arguments);
    };
    try {
      process.env.WY_OPS_CURRENT = path.join(dir, 'current', 'vscode');
      const s = require(path.join(stubDir, 'stub.js'));
      const ctx = { subscriptions: ['s'], extensionUri: 'stub-uri' };
      const out = s.activate(ctx);
      const realDir = fs.realpathSync(process.env.WY_OPS_CURRENT);
      assert.strictEqual(out.uri.fsPath, realDir, 'extensionUri는 설치본(정션을 푼 실제 경로)');
      assert.strictEqual(out.abs, path.join(realDir, 'media/x'));
      assert.deepStrictEqual(out.sub, ['s'], '나머지는 원래 컨텍스트');
      assert.strictEqual(out.api, 'api', '설치본 파일의 require(vscode)는 껍데기의 API');
      process.env.WY_OPS_CURRENT = path.join(tmp, 'none');
      delete require.cache[require.resolve(path.join(stubDir, 'stub.js'))];
      assert.strictEqual(require(path.join(stubDir, 'stub.js')).activate(ctx), undefined);
      assert.ok(api.err.includes('install.ps1 setup'), '설치본이 없으면 안내만 하고 멈춤');
    } finally {
      Module._load = load;
      delete process.env.WY_OPS_CURRENT;
    }
  }

  // 8. 패키지가 저장소 최상위(분리된 패키지 저장소): 전체 HEAD를 설치, source에 저장소·rel '' 기록
  {
    const prepo = path.join(tmp, 'pkgrepo');
    fs.mkdirSync(path.join(prepo, 'vscode', 'media'), { recursive: true });
    const pg = (...a) => execFileSync('git', a, { cwd: prepo, encoding: 'utf8' });
    pg('init', '-q');
    fs.writeFileSync(path.join(prepo, 'package.json'), JSON.stringify({ name: 'wy-ops', version: '0.7.1' }));
    fs.writeFileSync(path.join(prepo, 'vscode', 'package.json'), JSON.stringify(vpkg));
    fs.writeFileSync(path.join(prepo, 'vscode', 'media', 'icon.svg'), '<svg/>');
    fs.writeFileSync(path.join(prepo, 'vscode', 'extension.js'), 'exports.activate = () => {};\n');
    fs.mkdirSync(path.join(prepo, 'test'));
    fs.writeFileSync(path.join(prepo, 'test', 'a.test.js'), 'x');
    pg('add', '-A');
    pg('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'root');
    const dir2 = path.join(tmp, 'home2', 'wy-ops');
    const rr = deploy({ dir: dir2, pkg: prepo });
    assert.ok(rr.name.startsWith('0.7.1-'), rr.name);
    const d2 = JSON.parse(fs.readFileSync(path.join(dir2, 'current', 'deployed.json'), 'utf8'));
    assert.deepStrictEqual([d2.source.kind, path.resolve(d2.source.repo).toLowerCase(), d2.source.rel], ['head', path.resolve(prepo).toLowerCase(), '']);
    assert.ok(fs.existsSync(path.join(dir2, 'current', 'vscode', 'extension.js')) && !fs.existsSync(path.join(dir2, 'current', 'test')), '최상위 패키지도 테스트 제외');

    // 9. 개발 연결: current → 작업 사본(커밋 안 한 변경이 바로 보임), rollback으로 풀림
    fs.writeFileSync(path.join(prepo, 'package.json'), JSON.stringify({ name: 'wy-ops', version: '0.7.2' }));
    const dv = deployDev({ dir: dir2, pkg: prepo });
    assert.strictEqual(path.resolve(currentTarget(dir2)).toLowerCase(), path.resolve(prepo).toLowerCase(), '절대 경로로 보임');
    const dd = JSON.parse(fs.readFileSync(path.join(dir2, 'current', 'deployed.json'), 'utf8'));
    assert.deepStrictEqual([dd.version, dd.dev, dd.commit, dd.stubHash], ['0.7.2', true, 'dev', dv.stubHash]);
    assert.ok(fs.existsSync(path.join(dir2, 'current', 'stub-ext', 'package.json')), '껍데기는 작업 사본 안에');
    assert.deepStrictEqual(versions(dir2), [rr.name], '개발 연결은 버전 폴더가 아님');
    const back = rollback({ dir: dir2 });
    assert.strictEqual(back.to, rr.name);
    assert.strictEqual(currentTarget(dir2), rr.name, 'rollback으로 연결 풀림');
    assert.ok(fs.existsSync(path.join(prepo, 'package.json')), '작업 사본은 그대로');
  }

  // 7. assetsOf: contributes 안의 media 경로만
  assert.deepStrictEqual([...stub.assetsOf({ a: 'media/i.svg', b: ['./media/j.png', 'x.svg', 'media/../k.svg'] })].sort(), ['media/i.svg', 'media/j.png'], '..로 밖을 가리키는 경로는 뺌');
  console.log('wy-ops deploy 검사 통과');
} finally {
  rmTree(tmp);
}
