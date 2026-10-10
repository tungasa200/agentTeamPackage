// 원격 창 통합 터미널에서 역할 세션에 붙기(0.8.5, 노트북 호스트 제어 창·'<별칭> <역할>' 바로가기).
// 접속 PC의 제어 스크립트(templates/connect/host-control.ps1)가 ssh로 호스트에 요청 파일을 쓰고 VS Code 원격 창을 연다(열려 있으면 그 창으로).
// 이 확장은 원격 창(호스트 쪽 확장 호스트)에서 요청을 보고, 그 창의 폴더가 요청 폴더와 같으면 파일을 지워 가져간 뒤
// 통합 터미널에서 session.ps1 attach <역할>을 띄운다. 같은 이름의 터미널이 살아 있으면 새로 만들지 않고 그 터미널을 보여 준다.
//   요청 파일: %LOCALAPPDATA%\wy-ops\attach-request.json  { folder, role, at(UTC ISO, 호스트 시계) }. 2분이 지난 요청은 버린다
//   WY_OPS_ATTACH_FILE: 시험용 경로
const fs = require('fs');
const os = require('os');
const path = require('path');

const FRESH = 2 * 60 * 1000;
const POLL = 2000;
const ROLE = /^[A-Za-z0-9._-]{1,64}$/;
const SESSION_PS1 = path.join('.claude', 'skills', 'pm-ops', 'scripts', 'session.ps1');

const requestFile = (env = process.env) =>
  env.WY_OPS_ATTACH_FILE || path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'wy-ops', 'attach-request.json');
const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
const terminalName = (role) => `${role} 붙기`;

// 이 창의 폴더에 맞는 요청이면 { role, folder }, 아니면 null. 오래됐거나 깨진 요청은 지운다
function readRequest(file, folder, now = Date.now()) {
  let req;
  try {
    req = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code !== 'ENOENT') remove(file);
    return null;
  }
  const at = Date.parse(req && req.at);
  if (!req || !ROLE.test(String(req.role || '')) || !req.folder || !(Math.abs(now - at) <= FRESH)) {
    remove(file);
    return null;
  }
  if (!folder || norm(req.folder) !== norm(folder)) return null;
  return { role: req.role, folder };
}

function remove(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

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

// 원격 창에서만 돈다(호스트의 로컬 창이 요청을 가져가지 않게)
class AttachWatcher {
  constructor(vscode, { file = requestFile(), now = Date.now, interval = POLL } = {}) {
    this.vscode = vscode;
    this.file = file;
    this.now = now;
    this.timer = null;
    if (!vscode.env || !vscode.env.remoteName) return;
    this.check();
    this.timer = setInterval(() => this.check(), interval);
    if (this.timer.unref) this.timer.unref();
  }

  check() {
    if (!fs.existsSync(this.file)) return null;
    const ws = this.vscode.workspace.workspaceFolders && this.vscode.workspace.workspaceFolders[0];
    const req = readRequest(this.file, ws && ws.uri.fsPath, this.now());
    if (!req || !remove(this.file)) return null; // 지우지 못했으면 다른 창이 먼저 가져간 것
    try {
      return openTerminal(this.vscode, req);
    } catch (e) {
      this.vscode.window.showErrorMessage(`${req.role}에 붙지 못했습니다: ${e.message}`);
      return null;
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { AttachWatcher, readRequest, openTerminal, requestFile, terminalName, FRESH };
