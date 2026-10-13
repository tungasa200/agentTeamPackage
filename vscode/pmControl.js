// 세션 현황 맨 위 pm 제어 줄(0.10.0, design/pm-control 목업 P-1~P-8): pm 상태를 한 덩어리로 만들고 버튼을 처리한다.
// sessionsView가 세션을 읽을 때마다 observe(pm의 claude agents 항목, pm 상태 줄)를 부르고, view()를 webview에 보낸다.
//   [pm 시작]  session.ps1 start-pm latest(가장 최근 pm 인수인계). 60초 안에 백그라운드 pm이 안 뜨면 오류
//   [붙기]     통합 터미널 '<pm> 붙기'에서 session.ps1 attach <pm>(살아 있으면 그 터미널을 다시 보여 줌)
//   [pm 교체]  붙기 터미널에 ROTATE_TEXT를 넣으면 pm이 스스로 저장 → start-pm -Force → 이전 pm stop을 한다(반자동).
//              이 줄은 그 진행을 4단계로 지켜본다. 진행은 workspaceState에 두어 창을 닫았다 열어도 이어서 본다
//   [멈춤]     확인 창(Enter = 취소) 뒤 session.ps1 stop <pm>
// vscode·명령 실행·시계는 주입한다(test/pmControl.test.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isAlive } = require('./agentsReader');
const { transcriptFile, thresholds } = require('./contextSize');

const SESSION_PS1 = path.join('.claude', 'skills', 'pm-ops', 'scripts', 'session.ps1');
const terminalName = (role) => `${role} 붙기`;
// pm 교체: 붙기 터미널에 넣는 문구. pm이 pm-ops 절차(저장 → start-pm -Force → 이전 자신 stop)를 스스로 한다
const ROTATE_TEXT = 'pm 세션 교체 — 진행 중인 것을 저장하고 start-pm -Force로 새 pm을 띄운 뒤 이전 pm을 멈춰 줘';

// 살아 있는 같은 이름 터미널을 보여 주거나 새로 띄운다
function openTerminal(vscode, { role, folder }) {
  const name = terminalName(role);
  const live = vscode.window.terminals.find((t) => t.name === name && !t.exitStatus);
  if (live) {
    live.show();
    return { reused: true, terminal: live };
  }
  const terminal = vscode.window.createTerminal({
    name,
    cwd: folder,
    shellPath: 'powershell.exe',
    shellArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(folder, SESSION_PS1), 'attach', role],
  });
  terminal.show();
  return { reused: false, terminal };
}

const STORE_KEY = 'wyOps.pmRotation';
const START_LIMIT = 60 * 1000; // [pm 시작]·교체 2~3단계: 이 안에 안 되면 실패
const SAVE_LIMIT = 10 * 60 * 1000; // 교체 1단계(저장)는 pm이 하던 턴을 끝낸 뒤라 길다
const SAVE_SLOW = 30 * 1000; // 이보다 길면 "pm이 하던 일을 마치는 중"
const NEW_TERMINAL_DELAY = 5000; // 새로 연 붙기 터미널은 attach가 뜬 뒤에 문구를 넣는다
const START_TIMEOUT = 90 * 1000; // start-pm 명령 자체(claude --bg가 늦게 끝날 때)
const ID_RE = /^[0-9a-f][0-9a-f-]{3,63}$/i;
const STEPS = ['하던 일 저장', '새 pm 시작', '이전 pm 멈춤', '새 터미널로 붙기'];

// PowerShell 출력이 콘솔 코드 페이지(CP949)로 깨지지 않게 UTF-8로 바꾼 뒤 session.ps1을 부른다
function psArgs(ps1, ...args) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; & ${q(ps1)} ${args.join(' ')}`];
}

class PmControl {
  // deps: { vscode, store(workspaceState), folder(), ops(), run(label, file, args, timeoutMs), freeMem(), logFile, home, now, onChange, setTimeout }
  constructor(deps) {
    this.d = { now: Date.now, home: os.homedir(), freeMem: os.freemem, setTimeout, ...deps };
    this.agents = []; // claude agents의 pm 항목(교체 전·후 둘 다)
    this.row = null; // agentsReader가 만든 pm 상태 줄(살아 있는 것 우선 최신)
    this.op = null; // { kind: 'starting'|'startFailed'|'memory', at, error, freeMB }
    this.doneAt = 0; // 교체를 마친 시각(3초 "교체했습니다")
  }

  get name() {
    const o = this.d.ops();
    return (o && o.pmRole) || null;
  }

  get rotation() {
    return (this.d.store && this.d.store.get(STORE_KEY)) || null;
  }

  setRotation(r) {
    if (this.d.store) this.d.store.update(STORE_KEY, r);
  }

  // 교체·시작을 지켜보는 중이면 세션을 자주 읽는다(sessionsView가 3초 간격으로)
  busy() {
    const r = this.rotation;
    return (r && !r.fail) || (this.op && this.op.kind === 'starting');
  }

  log(line) {
    if (!this.d.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.d.logFile), { recursive: true });
      fs.appendFileSync(this.d.logFile, `${new Date(this.d.now()).toISOString()} ${line}\n`);
    } catch {
      // 기록을 못 남겨도 제어는 계속한다
    }
  }

  ps1() {
    const folder = this.d.folder();
    return folder ? path.join(folder, SESSION_PS1) : null;
  }

  async session(label, timeout, ...args) {
    const ps1 = this.ps1();
    if (!ps1) throw new Error('작업 폴더가 없습니다');
    this.log(`${label}: session.ps1 ${args.join(' ')}`);
    const out = await this.d.run(label, 'powershell.exe', psArgs(ps1, ...args), timeout);
    String(out || '').split(/\r?\n/).filter((l) => l.trim()).forEach((l) => this.log(`  ${l}`));
    return out;
  }

  alive() {
    return this.agents.filter(isAlive).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  // 교체 1단계 완료 근거: 교체를 누른 뒤 생긴 pm 인수인계 파일(<날짜>-<pm>[-n]-session.tmp)
  handoffSince(at) {
    const dir = path.join(this.d.home, '.claude', 'session-data');
    const re = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${this.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?-session\\.tmp$`);
    try {
      return fs.readdirSync(dir).some((f) => re.test(f) && fs.statSync(path.join(dir, f)).mtimeMs >= at);
    } catch {
      return false;
    }
  }

  observe(agents, row) {
    this.agents = agents || [];
    this.row = row || null;
    const now = this.d.now();
    const live = this.alive();
    if (this.op && this.op.kind === 'starting') {
      if (live.some((a) => a.kind === 'background')) {
        this.log('pm 시작됨');
        this.op = null;
      } else if (now - this.op.at > START_LIMIT) {
        this.op = { kind: 'startFailed', error: 'pm이 60초 안에 뜨지 않았습니다. [기록 보기]에서 start-pm 출력을 확인하세요.' };
        this.log('pm 시작 실패: 60초 초과');
      }
    }
    this.advance(now, live);
  }

  // 교체 단계 진행. 한 번에 여러 단계를 넘을 수 있다
  advance(now, live) {
    let r = this.rotation;
    if (!r || r.fail) return;
    const fresh = live.filter((a) => a.sessionId !== r.fromSessionId);
    const oldAlive = live.some((a) => a.sessionId === r.fromSessionId);
    const next = () => {
      r = { ...r, times: [...r.times, now - r.stepAt], step: r.step + 1, stepAt: now };
      this.log(`교체 ${r.step}/4: ${STEPS[r.step - 1]} 끝`);
    };
    const fail = (error) => {
      r = { ...r, fail: { step: r.step, error } };
      this.log(`교체 실패(${STEPS[r.step]}): ${error}`);
    };
    for (;;) {
      const before = r.step;
      if (r.step === 0) {
        if (fresh.length || this.handoffSince(r.at)) next();
        else if (now - r.stepAt > SAVE_LIMIT) fail(`pm이 10분 안에 하던 일을 저장하지 않았습니다. ${oldAlive ? '이전 pm은 그대로 일하고 있습니다.' : '이전 pm도 떠 있지 않습니다.'}`);
      } else if (r.step === 1) {
        if (fresh.length) next();
        else if (now - r.stepAt > START_LIMIT) fail(`새 pm이 60초 안에 뜨지 않았습니다. ${oldAlive ? '이전 pm은 그대로 일하고 있습니다.' : '이전 pm도 떠 있지 않습니다. [다시 시도]로 새 pm을 띄우세요.'}`);
      } else if (r.step === 2) {
        if (!oldAlive) next();
        else if (now - r.stepAt > START_LIMIT) fail('이전 pm이 60초 안에 멈추지 않았습니다. 새 pm은 일하고 있고, 지금 pm이 둘 떠 있습니다.');
      } else if (r.step === 3) {
        this.reattach();
        next();
      }
      if (r.fail || r.step === before) break;
      if (r.step >= STEPS.length) {
        this.log('교체했습니다');
        this.doneAt = now;
        r = null;
        break;
      }
    }
    this.setRotation(r);
  }

  // 교체 4단계: 이전 pm에 붙어 있던 터미널은 끊겼으므로 닫고 새로 붙는다
  reattach() {
    const { vscode } = this.d;
    const name = terminalName(this.name);
    for (const t of vscode.window.terminals || []) if (t.name === name && t.dispose) t.dispose();
    this.attach();
  }

  attach() {
    const folder = this.d.folder();
    if (!folder || !this.name) return null;
    return openTerminal(this.d.vscode, { role: this.name, folder });
  }

  async start(force = false) {
    if (this.op && this.op.kind === 'starting') return;
    this.op = { kind: 'starting', at: this.d.now() };
    this.changed();
    try {
      await this.session('pm 시작', START_TIMEOUT, 'start-pm', 'latest', ...(force ? ['-Force'] : []));
    } catch (err) {
      this.log(`pm 시작 실패: ${err.message}`);
      if (this.op && this.op.kind === 'starting') this.op = { kind: 'startFailed', error: `pm을 시작하지 못했습니다(${err.message}).` };
      this.changed();
    }
  }

  rotate() {
    const r = this.rotation;
    if (r && !r.fail) return;
    const cur = this.alive()[0];
    if (!cur) return;
    const ops = this.d.ops() || {};
    const blockMB = (ops.memory && ops.memory.blockFreeMB) || 500;
    const free = this.d.freeMem();
    if (free < blockMB * 1024 * 1024) {
      this.op = { kind: 'memory', freeGB: (free / 1024 ** 3).toFixed(1) };
      this.log(`교체 안 함: 여유 메모리 ${Math.round(free / 1024 ** 2)}MB`);
      this.changed();
      return;
    }
    this.op = null;
    const now = this.d.now();
    this.setRotation({ fromSessionId: cur.sessionId || null, fromId: cur.id || null, at: now, step: 0, stepAt: now, times: [], fail: null });
    this.log(`pm 교체 시작(이전 pm ${cur.id || cur.sessionId})`);
    this.sendRotateText();
    this.changed();
  }

  sendRotateText() {
    const opened = this.attach();
    if (!opened) return;
    const send = () => opened.terminal.sendText(ROTATE_TEXT);
    if (opened.reused) send();
    else this.d.setTimeout(send, NEW_TERMINAL_DELAY);
  }

  // [다시 시도]: 실패한 단계부터
  async retry() {
    if (this.op && this.op.kind === 'startFailed') return this.start();
    const r = this.rotation;
    if (!r || !r.fail) return undefined;
    const now = this.d.now();
    this.setRotation({ ...r, fail: null, stepAt: now });
    this.log(`교체 다시 시도(${STEPS[r.fail.step]})`);
    this.changed();
    if (r.fail.step === 0) this.sendRotateText();
    else if (r.fail.step === 1) await this.session('새 pm 시작', START_TIMEOUT, 'start-pm', 'latest', '-Force').catch((e) => this.log(`실패: ${e.message}`));
    else if (r.fail.step === 2 && ID_RE.test(String(r.fromId || ''))) await this.stopId(r.fromId);
    return undefined;
  }

  close() {
    this.op = null;
    if (this.rotation) this.setRotation(null);
    this.changed();
  }

  async stopId(id) {
    if (!ID_RE.test(String(id || ''))) return;
    this.log(`이전 pm 멈춤: claude stop ${id}`);
    await this.d.run('claude stop', process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `claude stop ${id}`]).catch((e) => this.log(`실패: ${e.message}`));
  }

  // pm이 둘 떠 있을 때(교체가 반만 됨): 오래된 쪽을 멈춘다
  async stopOld() {
    const live = this.alive();
    if (live.length < 2) return;
    await this.stopId(live[live.length - 1].id);
  }

  // [멈춤]: VS Code 확인 창. 취소를 먼저 넘기고 isCloseAffordance로 Esc·Enter가 취소가 되게 한다(R-3)
  async stop() {
    const { vscode } = this.d;
    const working = this.row && this.row.view === 'working';
    const detail = (working ? '지금 작업 중입니다. 멈추면 하던 일이 중간에 끊깁니다. ' : '') +
      '대화는 남아서 [pm 시작]으로 이어집니다.\n다른 역할 세션과 승인 카드는 그대로입니다.';
    const pick = await vscode.window.showWarningMessage(`${this.name}을 멈출까요?`, { modal: true, detail }, { title: '취소', isCloseAffordance: true }, { title: '멈춤' });
    if (!pick || pick.title !== '멈춤') return;
    await this.session('pm 멈춤', undefined, 'stop', this.name).catch((e) => this.log(`실패: ${e.message}`));
  }

  openLog() {
    const { vscode } = this.d;
    if (!this.d.logFile) return;
    if (!fs.existsSync(this.d.logFile)) this.log('(기록 시작)');
    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(this.d.logFile));
  }

  changed() {
    if (this.d.onChange) this.d.onChange();
  }

  // webview로 보내는 pm 줄 한 덩어리
  view() {
    const name = this.name;
    if (!name) return null;
    const { vscode } = this.d;
    const now = this.d.now();
    const base = { name, host: vscode.env && vscode.env.remoteName ? os.hostname() : null };
    const r = this.rotation;
    if (r) {
      const steps = STEPS.map((label, i) => ({
        label,
        state: i < r.step ? 'done' : i === r.step ? (r.fail ? 'fail' : 'cur') : 'todo',
        ms: i < r.step ? r.times[i] : null,
      }));
      if (r.fail) return { ...base, mode: 'rotateFailed', steps, error: r.fail.error };
      return { ...base, mode: 'rotating', steps, step: r.step, slow: r.step === 0 && now - r.stepAt > SAVE_SLOW };
    }
    if (this.op && this.op.kind === 'memory') return { ...base, mode: 'memory', error: `메모리가 부족해 새 pm을 띄울 수 없습니다(여유 ${this.op.freeGB}GB). 다른 세션을 멈춘 뒤 다시 시도하세요.` };
    if (this.op && this.op.kind === 'startFailed') return { ...base, mode: 'startFailed', error: this.op.error };
    if (this.op && this.op.kind === 'starting') return { ...base, mode: 'starting' };
    const live = this.alive();
    if (!live.length) {
      const last = this.row;
      let stoppedAt = null;
      const ops = this.d.ops();
      const file = last && ops && ops.root ? transcriptFile(ops.root, last.sessionId, this.d.home) : null;
      try {
        if (file) stoppedAt = fs.statSync(file).mtimeMs;
      } catch {
        stoppedAt = null;
      }
      return { ...base, mode: 'stopped', never: !last, stoppedAt };
    }
    const row = this.row && this.row.alive ? this.row : null;
    const info = {
      ...base,
      view: (row && row.view) || 'input',
      startedAt: live[0].startedAt || null,
      pending: (row && row.pending) || null,
      tokens: (row && row.contextTokens) || null,
      limit: thresholds(this.d.ops()).contextTokens,
      rotate: !!(row && row.rotate),
      doneAt: this.doneAt && now - this.doneAt < 3000 ? this.doneAt : 0,
    };
    if (live.length > 1) return { ...info, mode: 'two', count: live.length };
    if (live[0].kind !== 'background') return { ...info, mode: 'interactive' };
    return { ...info, mode: 'running' };
  }
}

module.exports = { PmControl, psArgs, STEPS, STORE_KEY, ROTATE_TEXT };
