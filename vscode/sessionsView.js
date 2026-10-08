// 세션 현황(사이드바 webview): 메모리·프로세스·Claude 세션 상태. (운영 도구 구현 계획 3.2)
// extension.js는 register(context)만 부른다.
const vscode = require('vscode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { loadOpsConfig } = require('./opsConfig');
const { rootFor } = require('./approvalStore');
const { readSessionStatus } = require('./agentsReader');

const VIEW_ID = 'wyOps.sessions';
const INTERVAL = { memory: 5000, processes: 15000, sessions: 10000 };
const COMMAND_TIMEOUT = 8000;
const REVEAL_REPLAY_MS = 10000;

// stderr는 콘솔 코드 페이지(CP949)라 글자가 깨지므로 오류 문구는 종료 코드로만 만든다
function run(label, file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (!err) resolve(stdout);
      else if (err.killed) reject(new Error(`${label} 응답 없음(${COMMAND_TIMEOUT / 1000}초)`));
      else if (err.code === 'ENOENT') reject(new Error(`${label} 명령을 찾을 수 없음`));
      else reject(new Error(`${label} 실패(종료 코드 ${err.code})`));
    });
  });
}

function firstLine(err) {
  return String((err && err.message) || err).split(/\r?\n/).find((l) => l.trim()) || '알 수 없는 오류';
}

function readMemory() {
  return { total: os.totalmem(), free: os.freemem() };
}

// tasklist CSV: "이미지","PID","세션 이름","세션#","메모리 사용"("12,345 K")
async function readProcesses() {
  const out = await run('tasklist', 'tasklist', ['/fo', 'csv', '/nh']);
  const groups = new Map();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.match(/"([^"]*)"/g);
    if (!cols || cols.length < 5) continue;
    const image = cols[0].slice(1, -1).replace(/\.exe$/i, '');
    const kb = Number(cols[4].replace(/[^\d]/g, ''));
    if (!kb) continue;
    const key = image.toLowerCase();
    const g = groups.get(key) || { name: image, bytes: 0, count: 0 };
    g.bytes += kb * 1024;
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
}

function workspaceDir() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? folder.uri.fsPath : null;
}

// 세션 상태: claude agents + 권한 요청 파일 + 세션 등록 기록(agentsReader, 계획 2.2)
function readSessions() {
  const dir = workspaceDir();
  return readSessionStatus({ root: rootFor(dir), ops: dir ? loadOpsConfig(dir) : null });
}

// 메모리 경고 선(wy-ops.json memory, D-86): warnFreeMB 미만 주의, blockFreeMB 미만 위험
function readMemoryLimits() {
  const dir = workspaceDir();
  const m = (dir && (loadOpsConfig(dir) || {}).memory) || {};
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  return { warnFreeMB: num(m.warnFreeMB, 1024), blockFreeMB: num(m.blockFreeMB, 500) };
}

// 커밋 전담 역할: 열면(attach) 나온 뒤 --agent 없이 다시 뜰 수 있다(OPS-06 4)
function commitRole() {
  const dir = workspaceDir();
  const ops = dir ? loadOpsConfig(dir) : null;
  return (ops && ops.commitRole) || null;
}

// 역할 순서: 프로젝트 설정(.claude/wy-ops.json)의 roles, 없으면 CLAUDE.md 세션 역할 표, 둘 다 없으면 빈 목록
function readRoles() {
  const dir = workspaceDir();
  if (!dir) return [];
  const ops = loadOpsConfig(dir);
  if (ops && Array.isArray(ops.roles) && ops.roles.length) return ops.roles.map((r) => r && r.name).filter(Boolean);
  try {
    const text = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    const section = text.split(/^## /m).find((s) => s.startsWith('세션 역할')) || '';
    return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
  } catch {
    return [];
  }
}

const READERS = { memory: async () => readMemory(), processes: readProcesses, sessions: readSessions };

const OFF_ACK_KEY = 'wyOps.offMessageAck'; // { sessionId: 확인한 마지막 막힌 메시지 시각 }

class Provider {
  constructor(extensionUri, globalState) {
    this.extensionUri = extensionUri;
    this.globalState = globalState;
    this.view = undefined;
    this.timers = [];
    this.inflight = {};
    this.cache = {};
    this.folded = new Set(); // 접어 둔 블록은 읽지 않는다
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((msg) => {
      // 숨겼다 다시 보이면 webview가 새로 뜨므로 ready마다 마지막 값을 다시 보낸다
      if (msg.type === 'ready') {
        this.folded = new Set(msg.folded || []);
        this.post({ type: 'roles', data: readRoles() });
        this.post({ type: 'limits', data: readMemoryLimits() });
        Object.values(this.cache).forEach((m) => this.post(m));
        // 뷰가 막 열리는 중에 온 "세션 현황에서 보기"는 webview가 준비된 뒤 다시 보낸다
        if (this.lastReveal && Date.now() - this.lastReveal.at < REVEAL_REPLAY_MS) this.post(this.lastReveal.msg);
        if (view.visible) this.start();
      } else if (msg.type === 'refresh') {
        this.refreshAll().then(() => this.post({ type: 'refreshed' }));
      } else if (msg.type === 'open') {
        openSession(msg.id, msg.name);
      } else if (msg.type === 'ackOff' && typeof msg.sessionId === 'string') {
        this.ackOff(msg.sessionId);
      } else if (msg.type === 'fold') {
        if (msg.folded) this.folded.add(msg.source);
        else {
          this.folded.delete(msg.source);
          this.update(msg.source);
        }
      }
    });
    view.onDidChangeVisibility(() => (view.visible ? this.start() : this.stop()));
    view.onDidDispose(() => {
      this.stop();
      this.view = undefined;
    });
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource}`,
    ].join('; ');
    return fs
      .readFileSync(path.join(media.fsPath, 'panel.html'), 'utf8')
      .replace(/{{csp}}/g, csp)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{css}}/g, uri('panel.css'))
      .replace(/{{js}}/g, uri('panel.js'));
  }

  reveal(sessionId) {
    const msg = { type: 'reveal', sessionId };
    this.lastReveal = { msg, at: Date.now() };
    this.post(msg);
  }

  // '꺼진 뒤 메시지 옴' 경고: 사용자가 확인한 시각 뒤에 새로 막힌 메시지가 있을 때만 띄운다
  acks() {
    return (this.globalState && this.globalState.get(OFF_ACK_KEY)) || {};
  }

  applyAcks(rows) {
    const acks = this.acks();
    return rows.map((r) => {
      const msgs = (r.offMessages || []).filter((m) => !acks[r.sessionId] || m.at > acks[r.sessionId]);
      return { ...r, offWarning: msgs.length ? { count: msgs.length, lastAt: msgs[msgs.length - 1].at, from: [...new Set(msgs.map((m) => m.from).filter(Boolean))], summary: msgs[msgs.length - 1].summary } : null };
    });
  }

  ackOff(sessionId) {
    const cached = this.cache.sessions && this.cache.sessions.data;
    const row = cached && cached.find((r) => r.sessionId === sessionId);
    if (!row || !row.offWarning) return;
    const acks = { ...this.acks(), [sessionId]: row.offWarning.lastAt };
    if (this.globalState) this.globalState.update(OFF_ACK_KEY, acks);
    const msg = { ...this.cache.sessions, data: cached.map((r) => (r.sessionId === sessionId ? { ...r, offWarning: null } : r)) };
    this.cache.sessions = msg;
    this.post(msg);
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  // 같은 출처를 읽는 중이면 새로 띄우지 않고 그 결과를 기다린다
  update(source) {
    if (!this.inflight[source]) {
      this.inflight[source] = (async () => {
        let msg;
        try {
          const data = await READERS[source]();
          msg = { type: source, data: source === 'sessions' ? this.applyAcks(data) : data, at: Date.now() };
        } catch (err) {
          msg = { type: source, error: firstLine(err), at: Date.now() };
        }
        this.inflight[source] = undefined;
        this.cache[source] = msg;
        this.post(msg);
      })();
    }
    return this.inflight[source];
  }

  refreshAll() {
    return Promise.all(Object.keys(READERS).filter((s) => !this.folded.has(s)).map((s) => this.update(s)));
  }

  // 패널이 보일 때만 폴링한다
  start() {
    this.stop();
    this.refreshAll();
    this.timers = Object.keys(READERS).map((s) => setInterval(() => this.folded.has(s) || this.update(s), INTERVAL[s]));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }
}

const REVEAL_COMMAND = 'wyOps.revealSession';
const SESSION_ID_RE = /^[0-9a-f][0-9a-f-]{3,63}$/i;

// "열기"(OPS-04, D-89): VS Code 새 터미널에서 claude attach. PowerShell 실행 정책 때문에 claude.cmd로 부른다
async function openSession(id, name) {
  if (!SESSION_ID_RE.test(String(id || ''))) return;
  if (name && name === commitRole()) {
    const go = '열기';
    const pick = await vscode.window.showWarningMessage(
      `${name}에 연결(attach)합니다. 나온 뒤 이 세션이 역할(--agent) 없이 재시작될 수 있어, 커밋 승인을 계속 받으려면 pm 세션이 세션 교체(rotate)해야 할 수 있습니다.`,
      { modal: true },
      go,
    );
    if (pick !== go) return;
  }
  const terminal = vscode.window.createTerminal({ name: `${name || id} (attach)` });
  terminal.show();
  terminal.sendText(`claude.cmd attach ${id}`);
}

function register(context) {
  const provider = new Provider(context.extensionUri, context.globalState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand('wyOps.refresh', () => provider.refreshAll()),
    // 승인 센터의 "세션 현황에서 보기"(D-89): 뷰를 열고 그 세션 줄을 강조한다(인자는 전체 sessionId 또는 짧은 id)
    vscode.commands.registerCommand(REVEAL_COMMAND, async (sessionId) => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      provider.reveal(sessionId);
    }),
    { dispose: () => provider.stop() },
  );
  return provider;
}

module.exports = { register, VIEW_ID, REVEAL_COMMAND };
