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
const { readSessionStatus, readAgents } = require('./agentsReader');
const { notifyStuck } = require('./stuckTool');
const { PmControl } = require('./pmControl');
const { OrphanCleaner, AUTO_GAP_MS } = require('./orphanCleaner');

const VIEW_ID = 'wyOps.sessions';
const INTERVAL = { memory: 5000, processes: 15000, sessions: 10000, orphans: 60000 };
// 끊긴 SSH 접속이 남긴 묶음(0.10.0, [정리]·자동 정리 0.11.0): 설치본의 판정 스크립트(SSH 원격 호스트에서만, PowerShell이라 1~2초 → 60초 간격)
const ORPHANS_PS = path.join(os.homedir(), '.wy-tools', 'wy-ops', 'current', 'templates', 'connect', 'ssh-orphans.ps1');
const STUCK_INTERVAL = 60000; // 패널이 안 보여도 멈춤 의심을 pm에 알리려고 세션 상태를 이 간격으로 읽는다
const COMMAND_TIMEOUT = 8000;
const REVEAL_REPLAY_MS = 10000;
const PM_BUSY_INTERVAL = 3000; // pm 시작·교체를 지켜보는 동안 세션을 읽는 간격(패널이 안 보여도)

// stderr는 콘솔 코드 페이지(CP949)라 글자가 깨지므로 오류 문구는 종료 코드로만 만든다
function run(label, file, args, timeout = COMMAND_TIMEOUT) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (!err) resolve(stdout);
      else if (err.killed) reject(new Error(`${label} 응답 없음(${timeout / 1000}초)`));
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

// 세션 상태: claude agents + 권한 요청 파일 + 세션 등록 기록(agentsReader, 계획 2.2).
// 멈춤 의심인 세션은 여기서 pm 세션에 한 번 알린다(stuckTool.notifyStuck, 같은 도구 호출로는 한 번)
// pmAgents: pm 줄이 교체 전·후 pm을 함께 보려고 이름별 한 줄로 줄이기 전 pm 항목을 따로 넘긴다
async function readSessions() {
  const dir = workspaceDir();
  const root = rootFor(dir);
  const ops = dir ? loadOpsConfig(dir) : null;
  const list = await readAgents();
  const rows = await readSessionStatus({ root, ops, list });
  for (const r of rows) if (r.stuck) notifyStuck(root, r, (ops && ops.pmRole) || null);
  const pm = ops && ops.pmRole;
  return { rows, pmAgents: pm ? list.filter((s) => s && s.name === pm) : [] };
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

const orphanCleaner = new OrphanCleaner({ file: ORPHANS_PS, run });
const READERS = { memory: async () => readMemory(), processes: readProcesses, sessions: readSessions, orphans: () => orphanCleaner.read() };
// 접기 단위: 고아 줄은 프로세스 블록 안에 있어 프로세스를 접으면 읽지 않는다
const foldKey = (s) => (s === 'orphans' ? 'processes' : s);

const OFF_ACK_KEY = 'wyOps.offMessageAck'; // { sessionId: 확인한 마지막 막힌 메시지 시각 }

// pm 줄 버튼(webview 메시지 → PmControl)
const PM_ACTIONS = {
  pmStart: (pm) => pm.start(),
  pmAttach: (pm) => pm.attach(),
  pmRotate: (pm) => pm.rotate(),
  pmStop: (pm) => pm.stop(),
  pmStopOld: (pm) => pm.stopOld(),
  pmRetry: (pm) => pm.retry(),
  pmClose: (pm) => pm.close(),
  pmLog: (pm) => pm.openLog(),
};

class Provider {
  constructor(extensionUri, globalState, pm, cleaner = orphanCleaner) {
    this.extensionUri = extensionUri;
    this.cleaner = cleaner;
    this.globalState = globalState;
    this.pm = pm || null;
    this.pmTimer = null;
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
        this.postPm();
        // 뷰가 막 열리는 중에 온 "세션 현황에서 보기"는 webview가 준비된 뒤 다시 보낸다
        if (this.lastReveal && Date.now() - this.lastReveal.at < REVEAL_REPLAY_MS) this.post(this.lastReveal.msg);
        if (view.visible) this.start();
      } else if (msg.type === 'refresh') {
        this.refreshAll().then(() => this.post({ type: 'refreshed' }));
      } else if (msg.type === 'open') {
        openSession(msg.id, msg.name);
      } else if (PM_ACTIONS[msg.type] && this.pm) {
        Promise.resolve(PM_ACTIONS[msg.type](this.pm)).finally(() => this.update('sessions'));
      } else if (msg.type === 'orphansStop') {
        this.cleanOrphans(this.cleaner.stop('manual'));
      } else if (msg.type === 'ackOff' && typeof msg.sessionId === 'string') {
        this.ackOff(msg.sessionId);
      } else if (msg.type === 'fold') {
        if (msg.folded) this.folded.add(msg.source);
        else {
          this.folded.delete(msg.source);
          this.update(msg.source);
          if (msg.source === 'processes') this.update('orphans');
        }
      }
    });
    view.onDidChangeVisibility(() => (view.visible ? this.start() : this.stop()));
    // 자동 정리용 판정: 사이드바가 떠 있는 동안 10분마다(프로세스 블록을 접었거나 안 보여도). 표시용 60초 판정은 펼쳤을 때만
    this.startAutoClean();
    view.onDidDispose(() => {
      this.stopAutoClean();
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

  // pm 줄을 보내고, 시작·교체를 지켜보는 중이면 세션을 자주 읽는다
  postPm() {
    if (!this.pm) return;
    this.post({ type: 'pm', data: this.pm.view() });
    if (this.pm.busy() && !this.pmTimer) {
      this.pmTimer = setInterval(() => this.update('sessions'), PM_BUSY_INTERVAL);
      if (this.pmTimer.unref) this.pmTimer.unref();
    } else if (!this.pm.busy() && this.pmTimer) {
      clearInterval(this.pmTimer);
      this.pmTimer = null;
    }
  }

  // 같은 출처를 읽는 중이면 새로 띄우지 않고 그 결과를 기다린다
  update(source) {
    if (!this.inflight[source]) {
      this.inflight[source] = (async () => {
        let msg;
        try {
          let data = await (source === 'orphans' ? this.cleaner.read() : READERS[source]());
          if (source === 'sessions') {
            if (this.pm) this.pm.observe(data.pmAgents, data.rows.find((r) => r.name === this.pm.name));
            data = this.applyAcks(data.rows);
          }
          msg = { type: source, data, at: Date.now() };
        } catch (err) {
          msg = { type: source, error: firstLine(err), at: Date.now() };
        }
        this.inflight[source] = undefined;
        this.cache[source] = msg;
        this.post(msg);
        if (source === 'sessions') this.postPm();
        if (source === 'orphans' && msg.data) this.cleanOrphans(this.cleaner.maybeAuto(msg.data));
      })();
    }
    return this.inflight[source];
  }

  // 정리 결과 한 줄을 보내고(다시 열어도 보이게 cache), 줄의 수를 새로 읽는다
  async cleanOrphans(job) {
    if (!job) return;
    this.post({ type: 'orphansBusy' });
    const result = await job;
    const msg = { type: 'orphansResult', data: result };
    this.cache.orphansResult = msg;
    this.post(msg);
    await this.inflight.orphans;
    await this.update('orphans');
  }

  startAutoClean() {
    this.stopAutoClean();
    this.update('orphans');
    this.autoTimer = setInterval(() => this.update('orphans'), AUTO_GAP_MS);
    if (this.autoTimer.unref) this.autoTimer.unref();
  }

  stopAutoClean() {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
  }

  refreshAll() {
    return Promise.all(Object.keys(READERS).filter((s) => !this.folded.has(foldKey(s))).map((s) => this.update(s)));
  }

  // 패널이 보일 때만 폴링한다
  start() {
    this.stop();
    this.refreshAll();
    this.timers = Object.keys(READERS).map((s) => setInterval(() => this.folded.has(foldKey(s)) || this.update(s), INTERVAL[s]));
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
  let provider = null;
  const pm = new PmControl({
    vscode,
    store: context.workspaceState,
    folder: workspaceDir,
    ops: () => {
      const dir = workspaceDir();
      return dir ? loadOpsConfig(dir) : null;
    },
    run,
    logFile: path.join(context.logUri ? context.logUri.fsPath : path.join(os.tmpdir(), 'wy-ops'), 'pm-control.log'),
    onChange: () => provider && provider.postPm(),
  });
  provider = new Provider(context.extensionUri, context.globalState, pm);
  // 패널이 보이면 패널 폴링(10초)이 읽으므로 건너뛴다
  const stuckTimer = setInterval(() => (provider.view && provider.view.visible) || provider.update('sessions'), STUCK_INTERVAL);
  if (stuckTimer.unref) stuckTimer.unref();
  context.subscriptions.push(
    { dispose: () => clearInterval(stuckTimer) },
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand('wyOps.refresh', () => provider.refreshAll()),
    // 승인 센터의 "세션 현황에서 보기"(D-89): 뷰를 열고 그 세션 줄을 강조한다(인자는 전체 sessionId 또는 짧은 id)
    vscode.commands.registerCommand(REVEAL_COMMAND, async (sessionId) => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      provider.reveal(sessionId);
    }),
    { dispose: () => provider.stop() },
    { dispose: () => provider.stopAutoClean() },
    { dispose: () => provider.pmTimer && clearInterval(provider.pmTimer) },
  );
  // 창을 닫았다 열어도 교체 진행을 이어서 본다(R-4)
  if (pm.busy()) provider.update('sessions');
  return provider;
}

module.exports = { register, VIEW_ID, REVEAL_COMMAND, Provider };
