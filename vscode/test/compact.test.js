// 소형 화면 모드(VS Code 설정 wyOps.compact 또는 ui.compact): 설정이 켜졌을 때만 세 화면 <body>에 compact 클래스가 붙는다
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

// settings: VS Code 설정(fake.settings), change: 화면을 연 뒤 바꿀 설정 [키, 값]
function screens(dir, settings = {}, change) {
  const fake = install({ workspace: dir });
  Object.assign(fake.settings, settings);
  try {
    require(path.join(EXT, 'extension.js')).activate(fake.context);
    fake.commands['wyApprovals.open']();
    fake.commands['wyActivity.open']();
    const view = fake.resolveView('wyOps.sessions');
    if (change) fake.setSetting(...change);
    const sessions = bodyOf(view.webview.html);
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
// VS Code 설정이 켜지면 프로젝트 설정과 상관없이 켜지고, 꺼져 있으면 프로젝트 설정을 따른다
assert.strictEqual(uiBodyClass(null, true), 'compact');
assert.strictEqual(uiBodyClass({ ui: { compact: false } }, true), 'compact');
assert.strictEqual(uiBodyClass({ ui: { compact: true } }, false), 'compact');
assert.strictEqual(uiBodyClass({}, 'true'), '', '문자열 설정은 켜지지 않는다');

// 확장 설정 선언: 사용자 설정에만(application), 동기화하지 않음(PC마다 다르다)
const decl = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8')).contributes.configuration.properties['wyOps.compact'];
assert.deepStrictEqual([decl.type, decl.default, decl.scope, decl.ignoreSync], ['boolean', false, 'application', true]);

// 세 html 모두 자리표시가 있다
for (const f of ['panel.html', 'approvals.html', 'activity.html']) {
  assert.ok(fs.readFileSync(path.join(EXT, 'media', f), 'utf8').includes('<body class="{{bodyClass}}">'), f);
}

// 꺼짐(설정 없음) / 켜짐(PC별 local 파일)
const off = repo({});
assert.deepStrictEqual(screens(off), { sessions: '', approvals: '', activity: '' }, '꺼짐: 클래스 없음');
const on = repo({}, { ui: { compact: true } });
assert.deepStrictEqual(screens(on), { sessions: 'compact', approvals: 'compact', activity: 'compact' }, '켜짐: 세 화면 모두 compact');
const ALL = { sessions: 'compact', approvals: 'compact', activity: 'compact' };
const NONE = { sessions: '', approvals: '', activity: '' };
assert.deepStrictEqual(screens(off, { 'wyOps.compact': true }), ALL, 'VS Code 설정만 켜짐');
assert.deepStrictEqual(screens(on, { 'wyOps.compact': false }), ALL, 'VS Code 설정 꺼짐이면 local 파일을 따른다');
// 리로드 없이 반영: 연 뒤 설정을 바꾸면 세 화면을 다시 그린다
assert.deepStrictEqual(screens(off, {}, ['wyOps.compact', true]), ALL, '켜기 즉시 반영');
assert.deepStrictEqual(screens(off, { 'wyOps.compact': true }, ['wyOps.compact', false]), NONE, '끄기 즉시 반영');

// 꺼짐일 때 기존 화면과 같게: compact 규칙은 모두 body.compact/.compact 아래에만 있다
for (const f of ['panel.css', 'approvals.css', 'activity.css']) {
  const css = fs.readFileSync(path.join(EXT, 'media', f), 'utf8');
  const tail = css.slice(css.indexOf('소형 화면 모드'));
  const bad = tail.split('\n').filter((l) => /^[^\s/}*][^{]*\{/.test(l) && !/^(body\.compact|\.compact)\b/.test(l));
  assert.deepStrictEqual(bad, [], f + ': compact 밖 규칙');
}

for (const d of [off, on]) fs.rmSync(d, { recursive: true, force: true });
console.log('compact.test.js 통과');
