// 세션 상태 읽기(운영 도구 구현 계획 2.2): claude agents 목록에 권한 요청 파일과 세션 등록 기록을 붙여
// 화면이 바로 쓸 수 있는 상태(view)로 바꾼다. vscode에 의존하지 않아 훅(B2)·활동 탭(B3)·테스트에서도 쓴다.
//   readSessionStatus({ root, ops }) → [{ name, id, sessionId, kind, state, status, waitingFor, view, offReason, pending, roleMissing,
//                                         startedAt, alive, offMessages, contextTokens, rotate }]
//   contextTokens: 현재 대화 토큰(contextSize.js, 못 읽으면 null) · rotate: rotation.contextTokens(기본 15만) 이상이면 true — session.ps1 health와 같은 기준
//   view(사용자 확정 2026-10-07, 네 가지): working(일하는 중) · input(입력 대기) · permission(권한 대기) · off(꺼짐)
//   offReason(꺼짐일 때만): stopped(멈춤, claude stop) · done(스스로 끝남) · failed(오류로 끝남)
//   offMessages(꺼짐일 때만): 꺼진 뒤 이 세션 앞으로 보내려다 막힌 메시지 [{ at, from, summary }] — '꺼진 뒤 메시지 옴' 경고의 근거
//     (기록에 본문을 남기지 않으므로 summary는 대개 빈 문자열, from은 모르면 빈 문자열. 기록은 1MB를 넘으면 앞 절반이 지워진다)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { listPermissionRequests, readSessionRegistry } = require('./approvalStore');
const { readContextTokens, transcriptFile, thresholds } = require('./contextSize');

const COMMAND_TIMEOUT = 8000;

// waitingFor 중 사람이 도구 실행을 허용해야 하는 것(U-01). 'dialog open'(질문 대화상자)·'input needed'는 입력 대기(U-05)
const PERMISSION_WAITS = ['permission prompt', 'sandbox request', 'worker request'];
const INPUT_WAITS = ['dialog open', 'input needed'];

const lower = (v) => String(v || '').toLowerCase();

// claude는 npm .cmd 래퍼라 cmd.exe로 실행한다. stderr는 CP949라 글자가 깨지므로 오류 문구는 종료 코드로만 만든다
function readAgents() {
  return new Promise((resolve, reject) => {
    execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'claude agents --json --all'],
      { timeout: COMMAND_TIMEOUT, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          if (err.killed) reject(new Error(`claude agents 응답 없음(${COMMAND_TIMEOUT / 1000}초)`));
          else if (err.code === 'ENOENT') reject(new Error('claude agents 명령을 찾을 수 없음'));
          else reject(new Error(`claude agents 실패(종료 코드 ${err.code})`));
          return;
        }
        try {
          const list = JSON.parse(stdout);
          if (!Array.isArray(list)) throw new Error();
          resolve(list);
        } catch {
          reject(new Error('claude agents 출력을 해석하지 못함'));
        }
      });
  });
}

// 살아 있는 세션: interactive는 목록에 있으면 실행 중, 백그라운드는 프로세스(pid)나 status가 있을 때.
// --all이 함께 주는 끝난 백그라운드는 state만 있고 pid·status가 없다
function isAlive(s) {
  return s.kind === 'interactive' || s.pid != null || !!s.status;
}

// 이 이름의 세션이 지금 메시지를 받을 수 있는가(B2 SendMessage 훅과 같은 기준)
function isReachable(list, name) {
  return (list || []).some((s) => s && s.name === name && isAlive(s));
}

// 이름마다 한 줄: 살아 있는 것 우선, 그다음 최신 startedAt (교대 전 세션은 숨긴다)
function latestByName(list) {
  const best = new Map();
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const name = s.name || '(이름 없음)';
    const cur = best.get(name);
    let better;
    if (!cur) better = true;
    else if (isAlive(s) !== isAlive(cur)) better = isAlive(s);
    else better = (s.startedAt || 0) > (cur.startedAt || 0);
    if (better) best.set(name, s);
  }
  return best;
}

const STOPPED = ['stopped', 'exited', 'killed'];
const FAILED = ['failed', 'error', 'crashed'];

// 꺼진 이유. 꺼진 세션만 부른다
function offReasonOf(s) {
  const st = lower(s.state);
  if (STOPPED.includes(st)) return 'stopped';
  if (FAILED.includes(st)) return 'failed';
  return 'done';
}

function viewOf(s, hasPending) {
  const st = lower(s.state);
  const wf = lower(s.waitingFor);
  const alive = isAlive(s);
  // 꺼짐: 프로세스가 없거나(--all의 끝난 세션) 멈췄거나 오류로 끝남. done과 stopped는 끈 주체만 다르다
  if (!alive || STOPPED.includes(st) || FAILED.includes(st)) return 'off';
  if (PERMISSION_WAITS.includes(wf)) return 'permission';
  // 권한 요청 파일만 있을 때는 살아 있는 세션만 인정한다(훅이 기다리다 세션이 죽으면 파일이 남는다)
  if (hasPending) return 'permission';
  const status = lower(s.status);
  if (['working', 'running', 'starting'].includes(st) || status === 'busy') return 'working';
  // 질문 대화상자·다음 지시 기다림·일을 마치고 쉬는 중(done+idle, VS Code 세션 idle)은 모두 입력 대기(U-05)
  return 'input';
}

// 메시지 가드(B2-6)가 꺼진 세션 앞으로 보내려던 메시지를 막을 때 남기는 기록(<승인 폴더>/message-blocks.log, JSONL)
const MESSAGE_BLOCKS = 'message-blocks.log';
const MAX_BLOCKS = 500;
function readMessageBlocks(root) {
  if (!root) return [];
  let text;
  try {
    text = fs.readFileSync(path.join(root, MESSAGE_BLOCKS), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/).slice(-MAX_BLOCKS)) {
    if (!line.trim()) continue;
    try {
      const b = JSON.parse(line);
      if (b && b.to && Date.parse(b.at)) out.push({ at: b.at, from: String(b.from || ''), to: String(b.to), toSessionId: b.toSessionId || null, summary: String(b.summary || '').slice(0, 200) });
    } catch {
      // 모르는 줄은 건너뛴다
    }
  }
  return out;
}

// 꺼진 세션 앞으로, 그 세션이 뜬 뒤에 온 막힌 메시지(교대 전 세션 앞의 기록은 빼려고 startedAt과 비교)
function offMessagesOf(s, name, blocks) {
  const since = s.startedAt || 0;
  return blocks
    .filter((b) => (b.toSessionId ? b.toSessionId === s.sessionId : b.to === name) && Date.parse(b.at) > since)
    .map(({ at, from, summary }) => ({ at, from, summary }));
}

// 결정 전이고 만료되지 않은 권한 요청 중 세션마다 가장 최근 것
function pendingBySession(requests, now) {
  const out = new Map();
  for (const r of requests || []) {
    if (!r || !r.sessionId || r.decision) continue;
    const exp = Date.parse(r.expiresAt);
    if (!Number.isNaN(exp) && exp <= now) continue;
    const cur = out.get(r.sessionId);
    if (!cur || String(r.createdAt) > String(cur.createdAt)) out.set(r.sessionId, r);
  }
  return out;
}

// 역할 누락: --agent로 띄워야 하는 역할(wy-ops.json roles의 agent:true)인데 실제 agent_type이 다르다.
//   근거 1(우선): 가드 훅이 도구 사용 때 받은 값(agentTypeSeen, seenAt이 있을 때). 값이 없으면(null) --agent 없이 뜬 것이다
//   근거 2: SessionStart 기록(agentType). fork로 이어 띄우면 훅 입력에 agent_type이 없어 null이 남으므로 null은 '알 수 없음'
// 기록이 없으면(훅 설치 전에 뜬 세션) 판단하지 않는다
function roleMissingOf(s, ops, registry) {
  const role = ops && Array.isArray(ops.roles) && ops.roles.find((r) => r && r.name === s.name);
  if (!role || !role.agent) return false;
  const rec = s.sessionId && registry && registry.get(s.sessionId);
  if (!rec) return false;
  if (rec.seenAt) return (rec.agentTypeSeen || null) !== s.name;
  return rec.agentType != null && rec.agentType !== s.name;
}

function buildStatus(list, { requests = [], registry = new Map(), ops = null, blocks = [], now = Date.now() } = {}) {
  const pending = pendingBySession(requests, now);
  return [...latestByName(list || []).entries()].map(([name, s]) => {
    const p = s.sessionId ? pending.get(s.sessionId) : undefined;
    const view = viewOf(s, !!p);
    return {
      name,
      id: s.id || (s.sessionId || '').slice(0, 8) || null,
      sessionId: s.sessionId || null,
      kind: s.kind,
      state: s.state,
      status: s.status,
      waitingFor: s.waitingFor,
      view,
      offReason: view === 'off' ? offReasonOf(s) : null,
      pending: view === 'permission' && p ? { key: p.key, tool: p.tool, command: p.command } : null,
      roleMissing: roleMissingOf(s, ops, registry),
      startedAt: s.startedAt,
      alive: isAlive(s),
      offMessages: view === 'off' ? offMessagesOf(s, name, blocks) : [],
    };
  });
}

// 승인 폴더를 읽지 못해도 세션 목록은 보여 준다
function safe(fn, fallback) {
  try {
    return fn() || fallback;
  } catch {
    return fallback;
  }
}

// 대화 크기: 저장소 경로(ops.root)로 대화 기록 파일을 찾는다. 설정이 없으면 null
function withContext(rows, ops, home) {
  const { contextTokens } = thresholds(ops);
  return rows.map((r) => {
    const tokens = ops && ops.root && r.sessionId ? readContextTokens(transcriptFile(ops.root, r.sessionId, home)) : null;
    return { ...r, contextTokens: tokens, rotate: !!tokens && tokens >= contextTokens };
  });
}

async function readSessionStatus({ root, ops = null, list, home } = {}) {
  const agents = list || (await readAgents());
  const rows = buildStatus(agents, {
    requests: safe(() => listPermissionRequests(root), []),
    registry: safe(() => readSessionRegistry(root), new Map()),
    blocks: readMessageBlocks(root),
    ops,
  });
  return withContext(rows, ops, home);
}

module.exports = { readSessionStatus, readAgents, buildStatus, readMessageBlocks, isReachable, isAlive, PERMISSION_WAITS, INPUT_WAITS, MESSAGE_BLOCKS };
