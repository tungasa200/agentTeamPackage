// 세션 멈춤 감지(pm 제안 3번, 사용자 승인 2026-10-09): 백그라운드 역할 세션이 도구 한 번(셸 명령 등)에 오래 묶여 있으면
// 세션 현황에 '멈춤 의심 n분 · <명령 앞부분>'을 보이고, pm 세션에 한 번 알린다(decisions.log에 한 줄).
// 근거: 대화 기록(.jsonl) 끝에서 결과(tool_result)가 아직 없는 마지막 도구 호출(tool_use)과 그 시각.
//   묶인 동안 세션은 다른 세션의 메시지를 받지 못한다(실제 사례: 결정 파일을 포그라운드 until 루프로 기다리다 8분 넘게 묶임).
// 기준(wy-ops.json stuck): minutes(기본 10) · longMinutes(기본 30, 빌드·테스트·설치·하위 에이전트처럼 원래 오래 걸리는 것)
// vscode에 의존하지 않아 테스트에서도 쓴다.
const fs = require('fs');
const path = require('path');
const { paths } = require('./approvalStore');

const TAIL_BYTES = 512 * 1024; // 묶인 도구 호출은 기록의 마지막 줄 근처에 있다
const DEFAULTS = { minutes: 10, longMinutes: 30 };
const COMMAND_PREVIEW = 60;

// 원래 오래 걸리는 명령: 빌드·테스트·설치·컨테이너. 이것들은 longMinutes를 넘어야 멈춤 의심으로 본다
const LONG_COMMAND = /\b(gradlew?|mvnw?|vitest|jest|playwright|pytest|tox|cargo\s+(build|test)|go\s+(build|test)|dotnet\s+(build|test|restore)|npm\s+(ci|install|i|test|run\s+(build|test\S*))|pnpm\s+(install|i|test|build)|yarn(\s+(install|test|build))?|pip\s+install|docker\s+(build|compose)|msbuild|cmake\s+--build|make)\b/i;
const LONG_TOOLS = ['Agent', 'Task', 'Workflow']; // 하위 에이전트는 도구 한 번이 길다

function stuckThresholds(ops) {
  const s = (ops && ops.stuck) || {};
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  return { minutes: num(s.minutes, DEFAULTS.minutes), longMinutes: num(s.longMinutes, DEFAULTS.longMinutes) };
}

function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // 잘린 첫 줄
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function summarize(b) {
  const i = b.input || {};
  const raw = i.command || i.description || i.prompt || i.file_path || i.pattern || '';
  const one = String(raw).replace(/\s+/g, ' ').trim();
  return one.length > COMMAND_PREVIEW ? one.slice(0, COMMAND_PREVIEW - 1) + '…' : one;
}

// 결과가 아직 없는 마지막 도구 호출: { id, tool, command, long, since(ms) }. 없거나 못 읽으면 null
function readOpenTool(file) {
  const lines = file ? readTail(file) : null;
  if (!lines) return null;
  const done = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"tool_')) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (!o || o.isSidechain) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j];
      if (!b || typeof b !== 'object') continue;
      if (o.type === 'user' && b.type === 'tool_result') done.add(b.tool_use_id);
      else if (o.type === 'assistant' && b.type === 'tool_use') {
        // 뒤에서부터 보므로 처음 만난 호출이 마지막 호출이다. 결과가 있으면 묶인 도구가 없다
        if (done.has(b.id)) return null;
        const since = Date.parse(o.timestamp);
        if (!Number.isFinite(since)) return null;
        const command = summarize(b);
        const long = LONG_TOOLS.includes(b.name) || LONG_COMMAND.test(String((b.input && b.input.command) || ''));
        return { id: b.id, tool: b.name, command, long, since };
      }
    }
  }
  return null;
}

// 세션 현황 줄(agentsReader)에 붙일 멈춤 의심: 살아 있는 백그라운드 세션이 일하는 중(권한 대기 아님)에 기준을 넘김
function stuckOf(row, file, ops, now = Date.now()) {
  if (!row || row.kind !== 'background' || !row.alive || row.view !== 'working') return null;
  const open = readOpenTool(file);
  if (!open) return null;
  const t = stuckThresholds(ops);
  const minutes = Math.floor((now - open.since) / 60000);
  if (minutes < (open.long ? t.longMinutes : t.minutes)) return null;
  return { minutes, tool: open.tool, command: open.command, long: open.long, toolUseId: open.id, since: new Date(open.since).toISOString() };
}

// pm 세션에 한 번 알린다: decisions.log에 한 줄(pm이 이미 감시하는 곳). 같은 도구 호출로는 한 번만
// (여러 VS Code 창이 함께 보아도 표시 파일 sessions/<sessionId>.stuck-<도구 호출 id>를 먼저 만든 창만 쓴다).
// 알렸으면 그 줄을 돌려준다
function notifyStuck(root, row, pmRole, now = new Date()) {
  const s = row && row.stuck;
  if (!root || !s || !row.sessionId || !/^[A-Za-z0-9_-]{1,100}$/.test(s.toolUseId)) return null;
  const p = paths(root);
  const marker = path.join(root, 'sessions', `${row.sessionId}.stuck-${s.toolUseId}`);
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, now.toISOString() + '\n', { flag: 'wx' });
  } catch {
    return null; // 이미 알렸거나(다른 창 포함) 쓸 수 없다
  }
  const what = [s.tool, s.command].filter(Boolean).join(' ');
  const line = {
    id: `stuck-${row.sessionId.slice(0, 8)}-${s.toolUseId.slice(-8)}`,
    kind: 'stuck',
    session: row.name,
    relatedSessions: pmRole ? [pmRole] : [],
    decision: 'stuck',
    minutes: s.minutes,
    tool: s.tool,
    command: s.command,
    since: s.since,
    notice: `${row.name} 세션이 도구 한 번(${what})에 ${s.minutes}분째 묶여 있습니다(멈춤 의심). 묶인 동안 메시지를 받지 못합니다. 결정이 아니라 알림입니다.`,
    decidedAt: now.toISOString(),
  };
  try {
    fs.appendFileSync(p.log, JSON.stringify(line) + '\n', 'utf8');
  } catch {
    return null;
  }
  return line;
}

module.exports = { readOpenTool, stuckOf, notifyStuck, stuckThresholds, DEFAULTS, LONG_COMMAND };
