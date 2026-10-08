// 공용 테스트 도우미: 가짜 vscode 모듈로 확장을 불러온다(Extension Development Host 없이). 운영 도구 구현 계획 2.1
//   const fake = require('./fakeVscode').install({ workspace: 'C:/projects/erp-project' });
//   require('../extension').activate(fake.context);
//   fake.commands['wyApprovals.open']();  fake.panels[0].send({ type: 'ready' });  fake.panels[0].posts
// install() 뒤에 require한 모듈은 require('vscode')로 이 가짜를 받는다. uninstall()로 되돌린다.
const Module = require('module');
const path = require('path');

const fs = require('fs');

const EXT = path.resolve(__dirname, '..');
// 시험용 프로젝트 루트: 임시 폴더에 .claude/wy-ops.json을 만든다(패키지가 어느 저장소에 있든 같은 설정으로 돈다)
const REPO = (() => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wy-fake-repo-'));
  const names = ['commit', 'search', 'planner', 'design', 'pm', 'backend1', 'backend2', 'backend3', 'frontend', 'frontend2', 'browser', 'qa', 'qa2'];
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'wy-ops.json'), JSON.stringify({
    schema: 1,
    project: 'fake-project',
    rolePrefix: 'WY-',
    pmRole: 'WY-pm',
    commitRole: 'WY-commit',
    roles: names.map((n) => ({ name: `WY-${n}`, summary: n, agent: n !== 'pm' })),
    rotation: { transcriptMB: 2 },
    memory: { warnFreeMB: 1024, blockFreeMB: 500 },
    approvals: { namespace: 'fake-project', ttlMinutes: 60 },
  }));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
})();

function install({ workspace = null } = {}) {
  const fake = {
    commands: {},
    executed: [],
    serializers: {},
    viewProviders: {},
    panels: [],
    statusItems: [],
    terminals: [],
    messages: [],
    opened: [],
    subscriptions: [],
    settings: { 'wyOps.approvals.sound': false },
  };

  const makeWebview = (posts) => ({
    cspSource: 'csp',
    options: {},
    asWebviewUri: (u) => u,
    postMessage: (m) => posts.push(m),
    onDidReceiveMessage(f) { this.handler = f; return { dispose() {} }; },
    set html(h) { this._html = h; },
    get html() { return this._html; },
  });

  const makePanel = (type, title) => {
    const posts = [];
    const p = {
      type, title, posts, webview: makeWebview(posts), revealed: 0,
      reveal() { this.revealed++; },
      onDidDispose(f) { this.disposeHandler = f; return { dispose() {} }; },
      send(m) { return this.webview.handler(m); },
    };
    fake.panels.push(p);
    return p;
  };

  const vscode = {
    Uri: {
      joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString() { return this.fsPath; } }),
      file: (f) => ({ fsPath: f, toString() { return f; } }),
    },
    ViewColumn: { Active: -1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: function (id) { this.id = id; },
    env: { openExternal: (u) => fake.opened.push(u.fsPath) },
    workspace: {
      workspaceFolders: workspace ? [{ uri: { fsPath: workspace } }] : undefined,
      // 설정은 fake.settings('섹션.키')에서. 테스트 중 소리는 기본으로 끈다
      getConfiguration: (section) => ({ get: (k, d) => { const key = section ? `${section}.${k}` : k; return key in fake.settings ? fake.settings[key] : d; } }),
    },
    window: {
      registerWebviewViewProvider: (id, p) => { fake.viewProviders[id] = p; return { dispose() {} }; },
      registerWebviewPanelSerializer: (type, s) => { fake.serializers[type] = s; return { dispose() {} }; },
      createWebviewPanel: (type, title) => makePanel(type, title),
      createStatusBarItem: () => { const s = { show() { this.shown = true; }, dispose() {} }; fake.statusItems.push(s); return s; },
      createTerminal: (opts) => { const t = { opts, sent: [], show() { this.shown = true; }, sendText(x) { this.sent.push(x); } }; fake.terminals.push(t); return t; },
      showErrorMessage: (...a) => { fake.messages.push(['error', ...a]); return Promise.resolve(undefined); },
      showWarningMessage: (...a) => { fake.messages.push(['warning', ...a]); return Promise.resolve(fake.nextChoice); },
      showInformationMessage: (...a) => { fake.messages.push(['info', ...a]); return Promise.resolve(fake.nextChoice); },
    },
    commands: {
      registerCommand: (id, f) => { fake.commands[id] = f; return { dispose() {} }; },
      executeCommand: async (id, ...args) => { fake.executed.push([id, ...args]); return fake.commands[id] ? fake.commands[id](...args) : undefined; },
    },
  };

  // 가짜 webview view(사이드바) 하나를 만들어 provider에 붙인다
  fake.resolveView = (id) => {
    const posts = [];
    const view = { visible: true, posts, webview: makeWebview(posts), onDidChangeVisibility() {}, onDidDispose() {}, send(m) { return this.webview.handler(m); } };
    fake.viewProviders[id].resolveWebviewView(view);
    return view;
  };
  fake.makePanel = makePanel;
  fake.vscode = vscode;
  // globalState: 메모리에 두는 Memento(같은 fake 안에서 확장을 다시 켜도 남는다)
  const memento = new Map();
  fake.globalState = memento;
  fake.context = {
    extensionUri: { fsPath: EXT },
    subscriptions: fake.subscriptions,
    globalState: { get: (k, d) => (memento.has(k) ? JSON.parse(JSON.stringify(memento.get(k))) : d), update: async (k, v) => memento.set(k, JSON.parse(JSON.stringify(v))), keys: () => [...memento.keys()] },
  };

  const orig = Module._load;
  Module._load = (req, ...a) => (req === 'vscode' ? vscode : orig(req, ...a));
  // 앞선 테스트가 불러 둔 확장 모듈은 새 가짜로 다시 불러오게 한다
  for (const k of Object.keys(require.cache)) if (k.startsWith(EXT) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  fake.uninstall = () => {
    Module._load = orig;
    fake.subscriptions.forEach((s) => s && s.dispose && s.dispose());
  };
  return fake;
}

module.exports = { install, EXT, REPO };
