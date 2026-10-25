// 소형 화면 모드(ui.compact): 설정이 켜졌을 때만 세 화면 <body>에 compact 클래스가 붙는다
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { install, EXT } = require('./fakeVscode');
const { uiBodyClass } = require('../opsConfig');

function repo(base, local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-compact-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'wy-ops.json'), JSON.stringify({ schema: 1, project: 'p', approvals: { namespace: 'compact-test' }, ...base }));
  if (local) fs.writeFileSync(path.join(dir, '.claude', 'wy-ops.local.json'), JSON.stringify(local));
  return dir;
}

function bodyOf(html) {
  const m = /<body class="([^"]*)">/.exec(html);
  assert.ok(m, '<body class="…">가 있다');
  return m[1];
}

function screens(dir) {
  const fake = install({ workspace: dir });
  try {
    require(path.join(EXT, 'extension.js')).activate(fake.context);
    fake.commands['wyApprovals.open']();
    fake.commands['wyActivity.open']();
    const media = { fsPath: path.join(EXT, 'media') };
    const vscode = require('vscode');
    const sessions = bodyOf(fake.viewProviders['wyOps.sessions'].html(fake.panels[0].webview, { ...media, ...vscode.Uri.joinPath({ fsPath: EXT }, 'media') }));
    const approvals = bodyOf(fake.panels.find((p) => p.type === 'wyApprovals').webview.html);
    const activity = bodyOf(fake.panels.find((p) => p.type === 'wyActivity').webview.html);
    return { sessions, approvals, activity };
  } finally {
    fake.uninstall();
  }
}

// 설정 읽기
assert.strictEqual(uiBodyClass(null), '');
assert.strictEqual(uiBodyClass({}), '');
assert.strictEqual(uiBodyClass({ ui: {} }), '');
assert.strictEqual(uiBodyClass({ ui: { compact: false } }), '');
assert.strictEqual(uiBodyClass({ ui: { compact: 'true' } }), '', '문자열은 켜지지 않는다');
assert.strictEqual(uiBodyClass({ ui: { compact: true } }), 'compact');

// 세 html 모두 자리표시가 있다
for (const f of ['panel.html', 'approvals.html', 'activity.html']) {
  assert.ok(fs.readFileSync(path.join(EXT, 'media', f), 'utf8').includes('<body class="{{bodyClass}}">'), f);
}

// 꺼짐(설정 없음) / 켜짐(PC별 local 파일)
const off = repo({});
assert.deepStrictEqual(screens(off), { sessions: '', approvals: '', activity: '' }, '꺼짐: 클래스 없음');
const on = repo({}, { ui: { compact: true } });
assert.deepStrictEqual(screens(on), { sessions: 'compact', approvals: 'compact', activity: 'compact' }, '켜짐: 세 화면 모두 compact');

// 꺼짐일 때 기존 화면과 같게: compact 규칙은 모두 body.compact/.compact 아래에만 있다
for (const f of ['panel.css', 'approvals.css', 'activity.css']) {
  const css = fs.readFileSync(path.join(EXT, 'media', f), 'utf8');
  const tail = css.slice(css.indexOf('소형 화면 모드'));
  const bad = tail.split('\n').filter((l) => /^[^\s/}*][^{]*\{/.test(l) && !/^(body\.compact|\.compact)\b/.test(l));
  assert.deepStrictEqual(bad, [], f + ': compact 밖 규칙');
}

for (const d of [off, on]) fs.rmSync(d, { recursive: true, force: true });
console.log('compact.test.js 통과');
