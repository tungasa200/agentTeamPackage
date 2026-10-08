// WY 승인 센터: 작업창 탭 + 상태 표시줄 '승인 대기 N'. 데이터는 approvalStore.js의 파일 저장소.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./approvalStore');
const { ArrivalBell } = require('./arrivalBell');

const { loadOpsConfig } = require('./opsConfig');

const VIEW_TYPE = 'wyApprovals';
const OPEN_COMMAND = 'wyApprovals.open';
const POLL = 15000; // 파일 감시가 놓친 변경을 잡는 느린 주기
const ROLE_POLL = 30000; // 커밋 세션 역할 확인 주기(claude agents)

// 세션 상태 읽기(agentsReader). 아직 없으면 역할 경고를 건너뛴다
function sessionStatusReader() {
  try {
    const m = require('./agentsReader');
    return typeof m.readSessionStatus === 'function' ? m.readSessionStatus : null;
  } catch {
    return null;
  }
}

class ApprovalCenter {
  constructor(context) {
    this.context = context;
    this.panel = undefined;
    this.state = undefined;
    this.watchers = [];
    this.timer = undefined;
    this.debounce = undefined;

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.command = OPEN_COMMAND;
    this.status.name = 'WY 승인 대기';

    context.subscriptions.push(
      this.status,
      // 인자 { id }(요청 id)를 주면 탭을 열고 그 카드를 고른다(활동 탭의 "카드 열기", 계획 2.2)
      vscode.commands.registerCommand(OPEN_COMMAND, (arg) => this.open(arg)),
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        // VS Code를 다시 열면 탭을 되살린다
        deserializeWebviewPanel: async (panel) => this.attach(panel),
      }),
      { dispose: () => this.dispose() },
    );

    // 이 창의 워크스페이스가 속한 프로젝트의 승인 폴더(설정이 없으면 이전처럼 바탕 폴더)
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    this.root = store.rootFor(folder && folder.uri.fsPath);
    this.ops = folder ? loadOpsConfig(folder.uri.fsPath) : null;
    store.ensureDirs(this.root);
    this.loadLedger();
    this.roleWarnings = [];
    this.endedSessions = [];
    // 새 카드 소리(설정 wyOps.approvals.sound, 기본 켜짐)
    this.bell = new ArrivalBell({
      enabled: () => {
        const c = vscode.workspace.getConfiguration && vscode.workspace.getConfiguration('wyOps');
        return !c || c.get('approvals.sound', true) !== false;
      },
    });
    this.watch();
    this.timer = setInterval(() => this.reload(), POLL);
    this.roleTimer = setInterval(() => this.checkRoles(), ROLE_POLL);
    this.reload();
    this.checkRoles();
  }

  // 출처 대조(B2-1, Q3): 확장이 쓴 결정의 지문을 VS Code globalState에 남긴다. 세션은 globalState를 쓸 수 없다.
  // 원장을 처음 만들 때 이미 있던 결정은 그때의 내용 그대로 신뢰한다(baselineAt).
  loadLedger() {
    this.ledgerKey = `wyApprovals.ledger:${this.root.toLowerCase()}`;
    const state = this.context.globalState;
    let ledger = state && state.get(this.ledgerKey);
    if (!ledger || typeof ledger !== 'object' || !ledger.entries) {
      ledger = { baselineAt: new Date().toISOString(), entries: {}, ack: {} };
      for (const d of store.listDecisionDigests(this.root)) ledger.entries[d.id] = d.digest;
      if (state) state.update(this.ledgerKey, ledger);
    }
    this.ledger = ledger;
  }

  remember(id) {
    const file = path.join(store.paths(this.root).decisions, `${id}.json`);
    this.ledger.entries[id] = store.decisionDigest(fs.readFileSync(file, 'utf8'));
    if (this.context.globalState) this.context.globalState.update(this.ledgerKey, this.ledger);
  }

  // 원장에 없거나 내용이 바뀐 결정 파일. 사용자가 '확인함'을 누른 것(ack)은 같은 내용이면 다시 띄우지 않는다
  untrustedDecisions() {
    return store
      .listDecisionDigests(this.root)
      .filter((d) => this.ledger.entries[d.id] !== d.digest && this.ledger.ack[d.id] !== d.digest)
      .map((d) => d.id);
  }

  // 커밋 세션 역할 누락(OPS-06 2): 커밋 세션 이름인데 --agent 없이 뜬 세션
  async checkRoles() {
    const read = sessionStatusReader();
    const commitRole = this.ops && this.ops.commitRole;
    if (!read || !commitRole) return;
    try {
      const rows = await read({ root: this.root, ops: this.ops });
      // 권한·할 일 카드에 '세션 끝남'을 붙이는 데 쓴다. 목록에서 끝났다고 확인된 세션만(목록에 없는 세션은 모름으로 둔다)
      const ended = (rows || []).filter((r) => r.sessionId && r.alive === false).map((r) => r.sessionId).sort();
      if (JSON.stringify(ended) !== JSON.stringify(this.endedSessions)) {
        this.endedSessions = ended;
        this.reload();
      }
      const next = (rows || []).filter((r) => r.name === commitRole && r.roleMissing && r.alive !== false).map((r) => ({ name: r.name, id: r.id || null, sessionId: r.sessionId || null }));
      if (JSON.stringify(next) !== JSON.stringify(this.roleWarnings)) {
        this.roleWarnings = next;
        this.reload();
      }
    } catch {
      // 세션 목록을 못 읽으면 다음 주기에
    }
  }

  watch() {
    const p = store.paths(this.root);
    for (const target of [p.root, p.requests, p.decisions, p.used]) {
      try {
        this.watchers.push(fs.watch(target, () => this.schedule()));
      } catch {
        // 감시를 못 걸면 느린 주기만으로 갱신한다
      }
    }
  }

  schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.reload(), 150);
  }

  reload() {
    let state;
    try {
      state = store.readState(this.root);
      state.notice = this.legacyNotice();
      state.untrusted = this.untrustedDecisions();
      state.roleWarnings = this.roleWarnings;
      const ended = new Set(this.endedSessions || []);
      for (const r of state.pending) if (r.sessionId && ended.has(r.sessionId)) r.sessionEnded = true;
      state.alerts = [
        ...state.untrusted.map((id) => `출처 불명 결정: decisions/${id}.json — 승인 센터가 쓰지 않은 결정입니다. 위조일 수 있으니 확인하세요.`),
        ...state.roleWarnings.map((w) => `커밋 세션 역할 누락: ${w.name}(${w.id || '?'})이 --agent ${w.name} 없이 실행 중입니다. 커밋이 가드 훅에 막히니 session.ps1 rotate ${w.name} none으로 세션을 교체하세요.`),
      ];
      state.error = '';
      this.bell.update(state.pending.filter((r) => !r.broken).map((r) => r.id));
    } catch (err) {
      state = { ...(this.state || { pending: [], recent: [], root: this.root }), error: String(err.message || err) };
    }
    this.state = state;
    this.renderStatus();
    this.post({ type: 'state', state: { ...state, kinds: store.KINDS, routineKinds: store.ROUTINE_KINDS, rolePrefix: (this.ops && this.ops.rolePrefix) || '' } });
  }

  // 프로젝트 폴더로 옮긴 뒤 옛 바탕 폴더에 요청이 남아 있으면 알린다(그 요청은 이 탭에 보이지 않는다)
  legacyNotice() {
    if (this.root === store.ROOT) return '';
    const n = store.countPending(store.ROOT);
    return n ? `옛 승인 폴더(${store.ROOT}\\requests)에 결정 안 된 요청 ${n}건이 있습니다. 이 프로젝트의 요청은 ${this.root}\\requests에 써야 이 탭에 보입니다.` : '';
  }

  renderStatus() {
    const n = this.state.pending.length;
    const count = (k) => this.state.pending.filter((r) => r.kind === k).length;
    const choices = count('choice');
    const perms = count('permission');
    const todos = count('todo');
    const broken = this.state.pending.filter((r) => r.broken).length;
    const git = n - choices - perms - todos - broken;
    const parts = [git && `승인 ${git}건`, perms && `권한 요청 ${perms}건`, choices && `결정 요청 ${choices}건`, todos && `할 일 ${todos}건`, broken && `형식 오류 ${broken}건`].filter(Boolean).join(' · ');
    this.status.text = n ? `$(bell-dot) 승인 대기 ${n}` : '$(check) 승인 대기 없음';
    this.status.tooltip = n ? `WY 승인 센터: ${parts} — 눌러서 열기` : 'WY 승인 센터 열기';
    this.status.backgroundColor = n ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.status.accessibilityInformation = { label: n ? `승인 대기 ${parts}, 승인 센터 열기` : '승인 대기 없음, 승인 센터 열기' };
    this.status.show();
  }

  open(arg) {
    this.selectId = arg && typeof arg.id === 'string' ? arg.id : undefined;
    if (this.panel) {
      this.panel.reveal();
      if (this.selectId) this.post({ type: 'select', id: this.selectId });
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'WY 승인 센터', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    });
    this.attach(panel);
  }

  attach(panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    this.panel = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.iconPath = vscode.Uri.joinPath(media, 'approvals-icon.svg');
    panel.webview.html = this.html(panel.webview, media);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  onMessage(msg) {
    try {
      if (msg.type === 'ready') {
        this.reload();
        if (this.selectId) this.post({ type: 'select', id: this.selectId }); // 화면에서 카드 고르기는 B2-5
      }
      else if (msg.type === 'decide') {
        store.decide(msg.id, msg.decision, { reason: msg.reason, root: this.root });
        this.remember(msg.id);
        this.reload();
      } else if (msg.type === 'answer') {
        store.answer(msg.id, msg.answers, { note: msg.note, root: this.root });
        this.remember(msg.id);
        this.reload();
      } else if (msg.type === 'done') {
        store.markDone(msg.id, { note: msg.note, root: this.root });
        this.remember(msg.id);
        this.reload();
      } else if (msg.type === 'ackUntrusted' && typeof msg.id === 'string') {
        // 사용자가 출처 불명 결정을 확인했다(신뢰하는 것은 아니고, 같은 내용이면 다시 띄우지 않는다)
        const hit = store.listDecisionDigests(this.root).find((d) => d.id === msg.id);
        if (hit) {
          this.ledger.ack[msg.id] = hit.digest;
          if (this.context.globalState) this.context.globalState.update(this.ledgerKey, this.ledger);
        }
        this.reload();
      } else if (msg.type === 'reveal' && typeof msg.sessionId === 'string') {
        // 카드의 '세션 현황에서 보기'(B2-5)
        vscode.commands.executeCommand('wyOps.revealSession', msg.sessionId);
      } else if (msg.type === 'openActivity') {
        // 머리의 활동 버튼·g a·빈 상태의 '세션 활동 보기'(활동은 별도 탭, Q2)
        vscode.commands.executeCommand('wyActivity.open');
      } else if (msg.type === 'openFolder') {
        vscode.env.openExternal(vscode.Uri.file(this.root));
      }
    } catch (err) {
      this.post({ type: 'error', id: msg.id, message: String(err.message || err) });
      this.reload();
    }
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    const csp = ["default-src 'none'", `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`, `img-src ${webview.cspSource}`].join('; ');
    return fs
      .readFileSync(path.join(media.fsPath, 'approvals.html'), 'utf8')
      .replace(/{{csp}}/g, csp)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{css}}/g, uri('approvals.css'))
      .replace(/{{js}}/g, uri('approvals.js'));
  }

  post(msg) {
    if (this.panel) this.panel.webview.postMessage(msg);
  }

  dispose() {
    clearInterval(this.timer);
    clearInterval(this.roleTimer);
    clearTimeout(this.debounce);
    this.watchers.forEach((w) => w.close());
    this.watchers = [];
  }
}

module.exports = { ApprovalCenter, VIEW_TYPE, OPEN_COMMAND };
