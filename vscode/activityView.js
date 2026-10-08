// 활동 탭(작업창 webview): 세션 간 메시지 피드·세션 상태·결함 흐름 묶음(OPS-09). (운영 도구 구현 계획 3.3)
// extension.js는 register(context)만 부른다. 데이터는 sessionActivity.js(대화 기록)와 세션 상태(claude agents).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { ActivityReader, transcriptDir, bundle } = require('./sessionActivity');
const { loadOpsConfig } = require('./opsConfig');
const store = require('./approvalStore');

const VIEW_TYPE = 'wyActivity';
const OPEN_COMMAND = 'wyActivity.open';
const INTERVAL = { transcripts: 3000, status: 10000 }; // 메시지는 10초 안에 보여야 한다(OPS-09)
const MAX_BUNDLES = 40;
const DORMANT_MS = 2 * 60 * 60 * 1000; // 진행 중 묶음이 이만큼 조용하면 '휴면'으로 접는다(사용자 결정, 설정으로 빼지 않음)
const LANE_HOURS = 12; // 시간 보기가 고를 수 있는 가장 긴 범위
const LANE_STEP = 30000;

// 세션 상태: agentsReader.readSessionStatus(계획 2.2)가 생기면 그것을, 없으면 claude agents를 직접 읽는다
function statusReader() {
  try {
    const { readSessionStatus } = require('./agentsReader');
    if (typeof readSessionStatus === 'function') return readSessionStatus;
  } catch {
    // B1-1 전
  }
  return readAgentsFallback;
}

const PERMISSION_WAITS = ['permission prompt', 'sandbox request', 'worker request'];
const INPUT_WAITS = ['dialog open', 'input needed'];

// agentsReader가 없을 때 쓰는 대체 분류. 네 가지 상태(사용자 확정 2026-10-07): working·input·permission·off(done·stopped·failed)
function classify(s) {
  if (!s.status || ['stopped', 'failed'].includes(s.state)) return 'off'; // 프로세스 없음: 스스로 끝남·멈춤·오류 모두 꺼짐
  if (PERMISSION_WAITS.includes(s.waitingFor)) return 'permission';
  if (s.status === 'busy' || s.state === 'working') return 'working';
  return 'input'; // dialog open·input needed·일을 마친 idle(U-05)
}

function readAgentsFallback() {
  return new Promise((resolve, reject) => {
    execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'claude agents --json --all'], { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(new Error(err.killed ? 'claude agents 응답 없음' : `claude agents 실패(종료 코드 ${err.code})`));
      try {
        resolve(JSON.parse(out).map((s) => ({ name: s.name || '(이름 없음)', id: s.id, sessionId: s.sessionId, kind: s.kind, state: s.state, status: s.status, waitingFor: s.waitingFor, view: classify(s), pending: null, startedAt: s.startedAt })));
      } catch {
        reject(new Error('claude agents 출력을 해석하지 못함'));
      }
    });
  });
}

// 이름마다 한 줄: 살아 있는 것 우선, 그다음 최신 startedAt
function latestByName(list) {
  const out = new Map();
  for (const s of list) {
    const cur = out.get(s.name);
    const alive = (x) => (x.alive !== undefined ? x.alive : x.view !== 'off');
    if (!cur || (alive(s) && !alive(cur)) || (alive(s) === alive(cur) && (s.startedAt || 0) > (cur.startedAt || 0))) out.set(s.name, s);
  }
  return out;
}

class ActivityView {
  constructor(context) {
    this.context = context;
    this.panel = undefined;
    this.timers = [];
    this.status = { list: [], error: null, at: 0 };
    this.lastSent = '';
    this.clock = () => Date.now(); // 휴면 판정 시각(검사에서 바꾼다)
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    this.repo = folder ? folder.uri.fsPath : null;
    const ops = this.repo ? loadOpsConfig(this.repo) : null;
    this.root = ops ? ops.root : this.repo;
    this.ops = ops;
    this.roles = ops && Array.isArray(ops.roles) ? ops.roles.map((r) => r && r.name).filter(Boolean) : [];
    this.reader = this.root ? new ActivityReader({ dir: transcriptDir(this.root) }) : null;
    this.approvalsRoot = store.rootFor(this.repo);
  }

  open() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    this.attach(vscode.window.createWebviewPanel(VIEW_TYPE, 'WY 활동', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [media] }));
  }

  attach(panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    this.panel = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview, media);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    if (panel.onDidChangeViewState) panel.onDidChangeViewState(() => (panel.visible ? this.start() : this.stop()));
    panel.onDidDispose(() => {
      this.stop();
      this.panel = undefined;
    });
  }

  onMessage(msg) {
    if (msg.type === 'ready') {
      // 숨겼다 다시 보이면 webview가 새로 뜨므로 ready마다 전부 다시 보낸다
      this.lastSent = '';
      this.refresh();
      if (this.panel && this.panel.visible) this.start();
    } else if (msg.type === 'openCard' && typeof msg.id === 'string') {
      vscode.commands.executeCommand('wyApprovals.open', { id: msg.id });
    } else if (msg.type === 'revealSession' && typeof msg.sessionId === 'string') {
      vscode.commands.executeCommand('wyOps.revealSession', msg.sessionId);
    }
  }

  // 보이는 동안만 읽는다
  start() {
    this.stop();
    this.updateStatus();
    this.timers = [setInterval(() => this.refresh(), INTERVAL.transcripts), setInterval(() => this.updateStatus(), INTERVAL.status)];
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  async updateStatus() {
    if (this.statusInflight) return;
    this.statusInflight = true;
    try {
      const list = await statusReader()({ root: this.root, ops: this.ops });
      this.status = { list: Array.isArray(list) ? list : [], error: null, at: Date.now() };
    } catch (err) {
      this.status = { ...this.status, error: String((err && err.message) || err).split(/\r?\n/)[0] };
    }
    this.statusInflight = false;
    this.refresh();
  }

  refresh() {
    if (!this.panel) return;
    let state;
    try {
      state = this.buildState();
    } catch (err) {
      state = { error: `활동을 읽지 못했습니다: ${err.message}` };
    }
    const text = JSON.stringify(state); // 바뀐 것이 있을 때만 보낸다(now는 보낼 때 붙인다)
    if (text === this.lastSent) return;
    this.lastSent = text;
    this.post({ type: 'state', state: { ...state, now: Date.now(), rolePrefix: (this.ops && this.ops.rolePrefix) || '' } });
  }

  buildState() {
    if (!this.reader) return { error: '열린 폴더가 없어 트랜스크립트 위치를 알 수 없습니다.' };
    this.reader.poll();
    const now = this.clock();
    const feed = this.reader.feed();
    const byName = latestByName(this.status.list);
    const actions = new Map(this.reader.lastActions().map((a) => [a.name, a]));

    // 세션 칩: 프로젝트 역할 순서, 역할 목록이 없으면 claude agents 순서
    const names = this.roles.length ? this.roles : [...byName.keys()];
    const sessions = names.map((name) => {
      const s = byName.get(name);
      const a = actions.get(name);
      // offWarn: 꺼진 뒤 이 세션 앞으로 보내려다 막힌 메시지 수(agentsReader offMessages)
      return { name, view: s ? s.view : 'off', offReason: s ? s.offReason || null : null, offWarn: s && s.offMessages ? s.offMessages.length : 0, sessionId: s ? s.sessionId : null, pending: s ? s.pending || null : null, doing: a ? a.doing : null, lastAt: a ? a.lastAt : null };
    });

    const views = new Map(sessions.map((s) => [s.name, s.view]));
    let cards = [];
    try {
      cards = store.readState(this.approvalsRoot).pending.filter((r) => !r.broken);
    } catch {
      // 승인 폴더가 없으면 카드 연결 없이 보여 준다
    }
    const all = bundle(feed).map((b) => {
        const card = cards.filter((c) => b.sessions.includes(c.session) && String(c.createdAt || '') >= b.startedAt).pop();
        const blockedBy = b.state !== 'done' ? b.sessions.find((n) => views.get(n) === 'permission') : null;
        const state = blockedBy ? 'perm' : card && b.state !== 'done' ? 'me' : b.state;
        return {
          key: b.key,
          taskId: b.taskId,
          title: b.title,
          state,
          // 완료 판정: 단계 사슬의 마지막이 완료([완료]·재검증 통과)이고, 권한 대기·대기 카드가 걸려 있지 않다.
          // 다시 메시지가 붙으면 마지막 단계가 바뀌어 진행 중으로 돌아간다(묶음은 lastAt 최신순)
          done: state === 'done',
          // 휴면: 진행 중인데 마지막 메시지 뒤 DORMANT_MS 넘게 움직임이 없다. 권한 대기·대기 카드가 걸린 묶음은 사람 손을 기다리는 중이라 제외
          dormant: state !== 'done' && state !== 'perm' && state !== 'me' && now - Date.parse(b.lastAt) > DORMANT_MS,
          startedAt: b.startedAt,
          lastAt: b.lastAt,
          sessions: b.sessions,
          steps: b.messages.map((m, i) => ({ id: m.id, from: m.from, stage: b.stages[i] })),
          card: card ? { id: card.id, title: card.title } : null,
        };
      });
    // 진행 중과 완료를 따로 자른다(완료가 많아도 진행 중 묶음이 밀려나지 않게)
    // 진행 중·휴면·완료를 따로 자른다(한쪽이 많아도 다른 쪽이 밀려나지 않게)
    const pick = (f) => all.filter(f).slice(0, MAX_BUNDLES);
    const bundles = [...pick((b) => !b.done && !b.dormant), ...pick((b) => b.dormant), ...pick((b) => b.done)];

    return {
      sessions,
      statusError: this.status.error,
      messages: Object.fromEntries(feed.map((m) => [m.id, { from: m.from, to: m.to, at: m.at, title: m.title, body: m.body }])),
      feed: feed.map((m) => m.id).reverse(),
      bundles,
      // 시간 보기(B3-3): 세션별 일한 구간. 30초 단위로 맞춰, 일하는 동안 3초마다 상태를 다시 보내지 않게 한다
      lanes: this.reader.bandsSince(Date.now() - LANE_HOURS * 3600000).map((l) => ({
        name: l.name,
        bands: l.bands.map(([a, b]) => [Math.floor(a / LANE_STEP) * LANE_STEP, Math.ceil((b + 1) / LANE_STEP) * LANE_STEP]),
        from: Math.floor(l.from / LANE_STEP) * LANE_STEP, // 이 앞은 읽지 않은 구간
      })),
      unreadable: this.reader.unreadable,
      transcriptsMissing: fs.existsSync(this.reader.dir) ? null : this.reader.dir, // 메시지가 없는 것과 폴더를 못 찾은 것을 구분한다
      windowHours: 24,
    };
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    const csp = ["default-src 'none'", `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`, `img-src ${webview.cspSource}`].join('; ');
    return fs
      .readFileSync(path.join(media.fsPath, 'activity.html'), 'utf8')
      .replace(/{{csp}}/g, csp)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{css}}/g, uri('activity.css'))
      .replace(/{{js}}/g, uri('activity.js'));
  }

  post(msg) {
    if (this.panel) this.panel.webview.postMessage(msg);
  }
}

function register(context) {
  const view = new ActivityView(context);
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_COMMAND, () => view.open()),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, { deserializeWebviewPanel: async (panel) => view.attach(panel) }),
    { dispose: () => view.stop() },
  );
  return view;
}

module.exports = { register, VIEW_TYPE, OPEN_COMMAND, classify, latestByName };
