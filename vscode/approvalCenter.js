// WY 승인 센터: 작업창 탭 + 상태 표시줄 '승인 대기 N'. 데이터는 approvalStore.js의 파일 저장소.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./approvalStore');
const trust = require('./approvalTrust');
const { ArrivalBell, alertMode, notifyText, ring } = require('./arrivalBell');

const { loadOpsConfig } = require('./opsConfig');

const VIEW_TYPE = 'wyApprovals';
const OPEN_COMMAND = 'wyApprovals.open';
const RESET_ANCHORS_COMMAND = 'wyApprovals.resetTrustAnchors';
const POLL = 15000; // 파일 감시가 놓친 변경을 잡는 느린 주기
const ROLE_POLL = 30000; // 커밋 세션 역할 확인 주기(claude agents)

const KEY_STATE = 'wyApprovals.deviceKey'; // 이 기기의 서명 키(globalState, 기기 단위)

// 기기 기본 이름: 확장은 늘 작업 폴더가 있는 쪽(호스트)에서 돌아 os.hostname()이 호스트 이름이다. 창 종류와 기기 id로 구분한다
function deviceName() {
  const env = vscode.env || {};
  const id = String(env.machineId || '').replace(/[^0-9a-f]/gi, '').slice(0, 4);
  return `${env.remoteName ? '원격 창' : '이 PC'}${id ? ' ' + id : ''}`;
}

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
      vscode.commands.registerCommand(RESET_ANCHORS_COMMAND, () => this.resetAnchors()),
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
    this.loadTrust();
    this.roleWarnings = [];
    this.endedSessions = [];
    // 새 카드 알림(설정 wyOps.approvals.sound로 끄기, 기본 켜짐). 로컬 창은 소리, 원격 창은 접속 PC 소리+VS Code 알림(wyOps.approvals.alert)
    const config = () => vscode.workspace.getConfiguration && vscode.workspace.getConfiguration('wyOps');
    this.bell = new ArrivalBell({
      enabled: () => {
        const c = config();
        return !c || c.get('approvals.sound', true) !== false;
      },
      play: (ids) => {
        const c = config();
        const mode = alertMode(c ? c.get('approvals.alert', 'auto') : 'auto', vscode.env && vscode.env.remoteName);
        if (mode.sound) ring(vscode.env && vscode.env.remoteName, (id) => vscode.commands.executeCommand(id));
        if (!mode.notify) return;
        const byId = new Map((this.pendingRows || []).map((r) => [r.id, r]));
        Promise.resolve(vscode.window.showInformationMessage(notifyText(ids.map((id) => byId.get(id) || { id })), '승인 센터 열기'))
          .then((pick) => pick && this.open({ id: ids[0] }))
          .catch(() => {});
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
    const digest = store.decisionDigest(fs.readFileSync(file, 'utf8'));
    this.ledger.entries[id] = digest;
    if (this.context.globalState) this.context.globalState.update(this.ledgerKey, this.ledger);
    // 다른 기기의 승인 센터도 이 결정을 믿을 수 있게 이 기기 키로 서명한다
    try {
      trust.signDecision(this.root, this.key, id, digest);
    } catch {
      // 서명을 못 쓰면 이 기기 원장만으로 신뢰한다(다른 기기에는 출처 불명으로 보인다)
    }
  }

  // 기기 신뢰(접속 기기 N대): 키는 기기 단위(globalState는 기기의 VS Code마다 하나라 같은 기기의 창은 함께 쓴다).
  // 뿌리 고정(anchors)은 승인 폴더마다. 명부가 없으면 이 기기가 뿌리가 된다.
  loadTrust() {
    const state = this.context.globalState;
    let key = state && state.get(KEY_STATE);
    if (!key || typeof key.pub !== 'string' || typeof key.priv !== 'string') {
      key = trust.newKey();
      if (state) state.update(KEY_STATE, key);
    }
    this.key = key;
    this.anchorsKey = `wyApprovals.anchors:${this.root.toLowerCase()}`;
    const anchors = state && state.get(this.anchorsKey);
    this.anchors = Array.isArray(anchors) ? anchors : [];
    this.ensureRoot();
  }

  // 명부가 없으면 이 기기가 뿌리가 된다. 원격 창(Remote-SSH)은 뿌리를 만들지 않는다: 원격 창 키는 호스트의
  // ~/.vscode-server에 있고 접속하는 노트북 모두가 함께 써서, 뿌리는 호스트 로컬 창이 맡는다
  ensureRoot() {
    if (vscode.env && vscode.env.remoteName) return;
    if (trust.ensureRoot(this.root, this.key, deviceName())) {
      this.anchors = [{ fp: trust.fingerprint(this.key.pub), pub: this.key.pub }];
      this.saveAnchors();
    }
  }

  // 명령 'WY: 기기 신뢰 고정 초기화': 이 기기에 고정한 뿌리를 비운다(명부를 새로 만든 뒤 옛 뿌리를 버릴 때).
  // 확인을 한 번 받는다. 비우면 지금 명부의 뿌리 지문을 비교해 다시 등록을 요청하는 안내가 뜬다
  async resetAnchors() {
    const pick = await vscode.window.showWarningMessage(
      '이 기기에 고정한 뿌리 기기를 지웁니다. 이 창은 미등록 상태가 되고, 기기 명부의 뿌리 지문을 확인해 다시 등록을 요청해야 합니다. 명부를 새로 만든 경우에만 하세요.',
      { modal: true },
      '초기화',
    );
    if (pick !== '초기화') return false;
    this.anchors = [];
    this.saveAnchors();
    this.ensureRoot();
    this.reload();
    return true;
  }

  saveAnchors() {
    if (this.context.globalState) this.context.globalState.update(this.anchorsKey, this.anchors);
  }

  evaluateTrust() {
    return trust.evaluate(trust.readRoster(this.root), this.key, this.anchors);
  }

  // 원장에 없거나 내용이 바뀐 결정 파일. 신뢰하는 기기가 서명한 결정은 믿는다.
  // 사용자가 '확인함'을 누른 것(ack)은 같은 내용이면 다시 띄우지 않는다
  untrustedDecisions(ev = this.evaluateTrust()) {
    const sigs = trust.readSigs(this.root);
    return store
      .listDecisionDigests(this.root)
      .filter((d) => this.ledger.entries[d.id] !== d.digest && this.ledger.ack[d.id] !== d.digest && !trust.sigTrusted(sigs.get(d.id), d.digest, ev))
      .map((d) => d.id);
  }

  // 화면에 보낼 기기 목록·등록 요청
  devicesState(ev) {
    const last = new Map();
    for (const s of trust.readSigs(this.root).values()) if (s.at && (!last.has(s.fp) || s.at > last.get(s.fp))) last.set(s.fp, s.at);
    const root = trust.rosterRoot(trust.readRoster(this.root));
    return {
      selfFp: ev.selfFp,
      selfShort: trust.shortFp(ev.selfFp),
      selfName: deviceName(),
      selfStatus: ev.selfStatus,
      remote: !!(vscode.env && vscode.env.remoteName),
      root: root && { fp: root.fp, short: trust.shortFp(root.fp), name: root.name },
      list: ev.devices.map((d) => ({ ...d, lastSig: last.get(d.fp) || null })),
      // 등록 요청은 신뢰된 기기에서만 승인할 수 있다
      joins: ev.selfStatus === 'member' ? trust.readJoins(this.root).filter((j) => !ev.trusted.has(j.fp) && !ev.revoked.has(j.fp)).map((j) => ({ ...j, short: trust.shortFp(j.fp) })) : [],
    };
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
      const ev = this.evaluateTrust();
      state.untrusted = this.untrustedDecisions(ev);
      state.devices = this.devicesState(ev);
      state.roleWarnings = this.roleWarnings;
      const ended = new Set(this.endedSessions || []);
      for (const r of state.pending) if (r.sessionId && ended.has(r.sessionId)) r.sessionEnded = true;
      state.alerts = [
        ...state.untrusted.map((id) => `출처 불명 결정: decisions/${id}.json — 승인 센터가 쓰지 않은 결정입니다. 위조일 수 있으니 확인하세요.`),
        ...state.roleWarnings.map((w) => `커밋 세션 역할 누락: ${w.name}(${w.id || '?'})이 --agent ${w.name} 없이 실행 중입니다. 커밋이 가드 훅에 막히니 session.ps1 rotate ${w.name} none으로 세션을 교체하세요.`),
      ];
      state.error = '';
      this.pendingRows = state.pending;
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
    const joins = (this.state.devices && this.state.devices.joins.length) || 0;
    const n = this.state.pending.length + joins;
    const count = (k) => this.state.pending.filter((r) => r.kind === k).length;
    const choices = count('choice');
    const perms = count('permission');
    const todos = count('todo');
    const broken = this.state.pending.filter((r) => r.broken).length;
    const git = n - joins - choices - perms - todos - broken;
    const parts = [git && `승인 ${git}건`, joins && `기기 등록 ${joins}건`, perms && `권한 요청 ${perms}건`, choices && `결정 요청 ${choices}건`, todos && `할 일 ${todos}건`, broken && `형식 오류 ${broken}건`].filter(Boolean).join(' · ');
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
      } else if (msg.type === 'ackAllUntrusted') {
        // 지금 목록을 한 번에 확인함(기기 신뢰 도입 전에 다른 창이 쓴 결정 정리용). 지금 내용만, 바뀌면 다시 뜬다
        const now = new Map(store.listDecisionDigests(this.root).map((d) => [d.id, d.digest]));
        for (const id of this.untrustedDecisions()) this.ledger.ack[id] = now.get(id);
        if (this.context.globalState) this.context.globalState.update(this.ledgerKey, this.ledger);
        this.reload();
      } else if (msg.type === 'pinRoot' && typeof msg.fp === 'string') {
        // 새 기기: 화면에 보인 뿌리 지문이 지금 명부의 뿌리와 같을 때만 고정하고 등록을 요청한다
        const root = trust.rosterRoot(trust.readRoster(this.root));
        if (!root || root.fp !== msg.fp) throw new Error('명부의 뿌리가 바뀌었습니다. 지문을 다시 확인하세요');
        if (!this.anchors.some((a) => a.fp === root.fp)) this.anchors.push({ fp: root.fp, pub: root.pub });
        this.saveAnchors();
        trust.requestJoin(this.root, this.key, String(msg.name || '').trim().slice(0, 60) || deviceName());
        this.reload();
      } else if ((msg.type === 'approveJoin' || msg.type === 'rejectJoin') && typeof msg.fp === 'string') {
        const ev = this.evaluateTrust();
        if (ev.selfStatus !== 'member') throw new Error('등록된 기기에서만 승인할 수 있습니다');
        const join = trust.readJoins(this.root).find((j) => j.fp === msg.fp);
        if (!join) throw new Error('등록 요청이 없습니다');
        if (msg.type === 'approveJoin') trust.approveJoin(this.root, this.key, join);
        else trust.removeJoin(this.root, join.fp);
        this.reload();
      } else if (msg.type === 'revokeDevice' && typeof msg.fp === 'string') {
        const ev = this.evaluateTrust();
        if (ev.selfStatus !== 'member') throw new Error('등록된 기기에서만 해제할 수 있습니다');
        if (msg.fp === ev.selfFp) throw new Error('이 기기는 다른 기기에서 해제하세요');
        if (!ev.devices.some((d) => d.fp === msg.fp) || ev.revoked.has(msg.fp)) throw new Error('해제할 기기가 없습니다');
        trust.revokeDevice(this.root, this.key, msg.fp, store.listDecisionDigests(this.root));
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
      // 카드에 붙지 않는 오류(기기 등록·해제 등)는 화면 읽기 알림만으로는 안 보이므로 VS Code 알림으로도
      if (!msg.id) Promise.resolve(vscode.window.showErrorMessage(`WY 승인 센터: ${err.message || err}`)).catch(() => {});
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
