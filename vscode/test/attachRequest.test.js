// 원격 창 통합 터미널에서 붙기(0.8.5): 요청 파일을 원격 창이 가져가 터미널을 띄우고, 살아 있는 같은 터미널은 다시 쓴다.
//   node vscode/test/attachRequest.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AttachWatcher, readRequest, terminalName, FRESH } = require('../attachRequest');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-attach-'));
const file = path.join(base, 'attach-request.json');
const folder = path.join(base, 'proj');
const NOW = Date.parse('2026-10-10T12:00:00Z');
const write = (o) => fs.writeFileSync(file, JSON.stringify({ folder, role: 'WY-pm', at: new Date(NOW).toISOString(), ...o }));

function fakeVscode({ remoteName = 'ssh-remote', ws = folder } = {}) {
  const made = [];
  const v = {
    env: { remoteName },
    workspace: { workspaceFolders: ws ? [{ uri: { fsPath: ws } }] : undefined },
    window: {
      terminals: [],
      createTerminal(opts) {
        const t = { name: opts.name, opts, shown: 0, exitStatus: undefined, show() { this.shown++; } };
        made.push(t);
        v.window.terminals.push(t);
        return t;
      },
      showErrorMessage() {},
    },
  };
  return { v, made };
}

test('요청 읽기: 폴더가 같고 2분 안이면 가져가고, 오래됐거나 깨졌으면 지운다', () => {
  write({ folder: folder.toUpperCase() + '\\' });
  assert.deepStrictEqual(readRequest(file, folder, NOW), { role: 'WY-pm', folder }, '대소문자·끝 구분자 무시');
  assert.strictEqual(readRequest(file, path.join(base, 'other'), NOW), null, '다른 폴더 창은 건드리지 않음');
  assert.ok(fs.existsSync(file), '다른 폴더 창은 지우지 않음');
  assert.strictEqual(readRequest(file, folder, NOW + FRESH + 1), null);
  assert.ok(!fs.existsSync(file), '오래된 요청은 지움');
  write({ role: 'x; rm -rf' });
  assert.strictEqual(readRequest(file, folder, NOW), null);
  assert.ok(!fs.existsSync(file), '역할 이름이 이상하면 지움');
  fs.writeFileSync(file, '{깨짐');
  assert.strictEqual(readRequest(file, folder, NOW), null);
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(readRequest(file, folder, NOW), null, '없으면 null');
});

test('원격 창: 요청을 가져가 session.ps1 attach 터미널을 띄우고, 살아 있으면 다시 쓰고, 끝났으면 새로', () => {
  const { v, made } = fakeVscode();
  const w = new AttachWatcher(v, { file, now: () => NOW, interval: 60000 });
  try {
    write();
    const r = w.check();
    assert.strictEqual(r.reused, false);
    assert.ok(!fs.existsSync(file), '요청은 가져가며 지움');
    const t = made[0];
    assert.strictEqual(t.name, terminalName('WY-pm'));
    assert.strictEqual(t.opts.cwd, folder);
    assert.deepStrictEqual(t.opts.shellArgs.slice(-3), [path.join(folder, '.claude', 'skills', 'pm-ops', 'scripts', 'session.ps1'), 'attach', 'WY-pm']);
    assert.strictEqual(t.shown, 1);
    write();
    assert.strictEqual(w.check().reused, true, '살아 있으면 그 터미널');
    assert.deepStrictEqual([made.length, t.shown], [1, 2]);
    t.exitStatus = { code: 0 };
    write();
    assert.strictEqual(w.check().reused, false, '끝난 터미널이면 새로');
    assert.strictEqual(made.length, 2);
    assert.strictEqual(w.check(), null, '요청이 없으면 아무것도');
  } finally {
    w.dispose();
  }
});

test('로컬 창(호스트 자신의 창)은 요청을 보지 않는다', () => {
  const { v, made } = fakeVscode({ remoteName: '' });
  write();
  const w = new AttachWatcher(v, { file, now: () => NOW });
  assert.strictEqual(w.timer, null);
  assert.ok(fs.existsSync(file) && made.length === 0);
  w.dispose();
  fs.unlinkSync(file);
});

test('정리', () => fs.rmSync(base, { recursive: true, force: true }));
