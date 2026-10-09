// lib/extensionTargets.js: 껍데기 확장을 로컬·VS Code 서버 쪽 확장 폴더에 설치(0.8.0 P1)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../lib/extensionTargets');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-exttargets-'));
let n = 0;
function home() {
  const h = path.join(tmp, `h${++n}`);
  fs.mkdirSync(h, { recursive: true });
  return h;
}
// 확장 폴더에 껍데기를 깔아 둔다(extensions.json 있음/없음)
function plant(dir, hash, { list = true } = {}) {
  const folder = path.join(dir, `wy-ops.wy-ops-0.8.0`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'wy-ops', wyOpsStubHash: hash }));
  if (list) fs.writeFileSync(path.join(dir, 'extensions.json'), JSON.stringify([{ identifier: { id: 'wy-ops.wy-ops' }, relativeLocation: 'wy-ops.wy-ops-0.8.0' }]));
}
// 껍데기 폴더(vsix로 묶을 것)
const stubDir = path.join(tmp, 'stub-ext');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({ name: 'wy-ops', publisher: 'wy-ops', version: '0.8.0', engines: { vscode: '^1.85.0' }, wyOpsStubHash: 'new' }));
fs.writeFileSync(path.join(stubDir, 'stub.js'), '');

function fakeRun(status = () => 0) {
  const calls = [];
  const run = (cmd, args) => {
    const file = args[args.indexOf('--install-extension') + 1];
    calls.push({ cmd, args, vsixExists: fs.existsSync(file) });
    const s = status(args);
    return { status: s, stdout: '', stderr: s ? 'boom\nlast line' : '' };
  };
  return { run, calls };
}

// stubHashIn: extensions.json → 폴더, 없으면 폴더 이름으로, 아무것도 없으면 null
{
  const h = home();
  assert.strictEqual(t.stubHashIn(t.localDir(h)), null);
  plant(t.localDir(h), 'abc');
  assert.strictEqual(t.stubHashIn(t.localDir(h)), 'abc');
  const h2 = home();
  plant(t.serverDir(h2), 'xyz', { list: false });
  assert.strictEqual(t.stubHashIn(t.serverDir(h2)), 'xyz');
}

// targets: auto는 ~/.vscode-server가 있을 때만, force는 늘, skip은 로컬만. 로컬 override는 --extensions-dir로
{
  const h = home();
  assert.deepStrictEqual(t.targets({ home: h }).map((x) => x.name), ['local']);
  assert.deepStrictEqual(t.targets({ home: h }).find((x) => x.name === 'local').args, []);
  assert.deepStrictEqual(t.targets({ home: h, server: 'force' }).map((x) => x.name), ['local', 'server']);
  fs.mkdirSync(t.serverRoot(h));
  assert.deepStrictEqual(t.targets({ home: h }).map((x) => x.name), ['local', 'server']);
  assert.deepStrictEqual(t.targets({ home: h, server: 'skip' }).map((x) => x.name), ['local']);
  const srv = t.targets({ home: h }).find((x) => x.name === 'server');
  assert.deepStrictEqual(srv.args, ['--extensions-dir', t.serverDir(h)]);
  assert.deepStrictEqual(t.targets({ home: h, localOverride: 'X' })[0].args, ['--extensions-dir', 'X']);
}

// install: 해시가 같으면 건너뛰고, 다르면 code --install-extension(서버 쪽은 --extensions-dir, 폴더를 만들어 둠), vsix는 지운다
{
  const h = home();
  plant(t.localDir(h), 'new');
  const { run, calls } = fakeRun();
  const tmpdir = fs.mkdtempSync(path.join(tmp, 'v'));
  const r = t.install({ stubHash: 'new', stubDir, run, home: h, server: 'force', tmpdir });
  assert.deepStrictEqual(r.map((x) => [x.name, x.state]), [['local', 'same'], ['server', 'installed']]);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args.slice(0, 2), ['--extensions-dir', t.serverDir(h)]);
  assert.ok(calls[0].args.includes('--force'));
  assert.ok(calls[0].vsixExists, '설치 중에는 vsix가 있어야 한다');
  assert.ok(fs.existsSync(t.serverDir(h)), '서버 쪽 확장 폴더를 만들어 둔다');
  assert.deepStrictEqual(fs.readdirSync(tmpdir), [], 'vsix를 지운다');
}

// install: 둘 다 최신이면 code를 부르지 않는다
{
  const h = home();
  plant(t.localDir(h), 'new');
  plant(t.serverDir(h), 'new');
  const { run, calls } = fakeRun();
  const r = t.install({ stubHash: 'new', stubDir, run, home: h, tmpdir: tmp });
  assert.deepStrictEqual(r.map((x) => x.state), ['same', 'same']);
  assert.strictEqual(calls.length, 0);
}

// install: 서버 쪽 실패는 failed(마지막 줄을 error로), 로컬은 그대로 installed. vsix는 한 번만 만든다
{
  const h = home();
  fs.mkdirSync(t.serverRoot(h));
  const { run, calls } = fakeRun((args) => (args[0] === '--extensions-dir' ? 1 : 0));
  const tmpdir = fs.mkdtempSync(path.join(tmp, 'v'));
  const r = t.install({ stubHash: 'new', stubDir, run, home: h, tmpdir });
  assert.deepStrictEqual(r.map((x) => [x.name, x.state]), [['local', 'installed'], ['server', 'failed']]);
  assert.strictEqual(r[1].error, 'last line');
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].args[calls[0].args.indexOf('--install-extension') + 1], calls[1].args[calls[1].args.indexOf('--install-extension') + 1]);
  assert.deepStrictEqual(fs.readdirSync(tmpdir), []);
}

// serverStubState: doctor용
{
  const h = home();
  assert.deepStrictEqual(t.serverStubState(h, 'new'), { dir: t.serverDir(h), exists: false, hash: null, ok: false });
  fs.mkdirSync(t.serverRoot(h));
  assert.strictEqual(t.serverStubState(h, 'new').exists, true);
  assert.strictEqual(t.serverStubState(h, 'new').ok, false);
  plant(t.serverDir(h), 'old');
  assert.strictEqual(t.serverStubState(h, 'new').ok, false);
  assert.strictEqual(t.serverStubState(h, 'old').ok, true);
  assert.strictEqual(t.serverStubState(h).ok, true);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('extensionTargets.test.js: ok');
