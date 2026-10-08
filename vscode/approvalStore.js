// 승인 센터 저장소: ~/.claude/wy-approvals/<namespace>/ 아래 파일로 요청과 결정을 주고받는다.
// namespace는 프로젝트 설정(.claude/wy-ops.json의 approvals.namespace). 설정이 없으면 ~/.claude/wy-approvals/ 바로 아래(이전 방식).
//   requests/<id>.json   요청(세션이 쓴다): git 명령 승인 또는 선택지 결정(choice)
//   decisions/<id>.json  결정(확장만 쓴다). 임시 파일에 다 쓴 뒤 이름을 바꿔 생기므로, 파일이 보이면 완성된 결정이다
//   decisions.log        결정마다 한 줄(JSON)을 덧붙인다. 감시하는 쪽이 tail 하나로 새 결정을 알 수 있다
//   used/<id>.json       훅이 승인을 한 번 쓰고 남기는 표시(같은 승인으로 두 번 실행하지 못하게)
// vscode에 의존하지 않아 훅 스크립트와 테스트에서도 쓴다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadOpsConfig } = require('./opsConfig');

// 모든 프로젝트의 승인 폴더가 들어가는 바탕 폴더. 프로젝트 설정이 없을 때는 여기를 그대로 쓴다
const ROOT = process.env.WY_APPROVALS_DIR || path.join(os.homedir(), '.claude', 'wy-approvals');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// 이 폴더(저장소 안 어디든)가 속한 프로젝트의 승인 폴더
function rootFor(startDir) {
  const ops = startDir ? loadOpsConfig(startDir) : null;
  const ns = ops && ops.approvals && ops.approvals.namespace;
  return typeof ns === 'string' && ID_RE.test(ns) ? path.join(ROOT, ns) : ROOT;
}

// git 명령 승인 종류. commit·push는 일상 승인, 나머지는 PM 결정
const GIT_KINDS = {
  commit: '커밋',
  push: '푸시',
  'force-push': '강제 푸시',
  branch: '브랜치 생성',
  'delete-branch': '브랜치 삭제',
  merge: '병합',
  reset: '초기화',
  rebase: '리베이스',
  'tag-delete': '태그 삭제',
};
const ROUTINE_KINDS = ['commit', 'push'];
// permission: 권한 카드(PermissionRequest 훅), todo: 사람이 직접 할 일(PermissionDenied 훅 등, '완료'로 닫는다)
const KINDS = { ...GIT_KINDS, choice: '결정 요청', permission: '권한 요청', todo: '할 일' };
const LIMITS = { questions: 4, optionsMin: 2, optionsMax: 4, text: 2000 };
const REQUIRED = ['what', 'why', 'onClick'];

function paths(root = ROOT) {
  return {
    root,
    requests: path.join(root, 'requests'),
    decisions: path.join(root, 'decisions'),
    log: path.join(root, 'decisions.log'),
    used: path.join(root, 'used'),
  };
}

function ensureDirs(root = ROOT) {
  const p = paths(root);
  for (const d of [p.requests, p.decisions, p.used]) fs.mkdirSync(d, { recursive: true });
  return p;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// 임시 파일에 쓰고 이름을 바꿔, 읽는 쪽이 반쯤 쓴 파일을 보지 않게 한다
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function listJson(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && ID_RE.test(f.slice(0, -5)));
  } catch {
    return [];
  }
}

const normalize = (cmd) => String(cmd || '').trim().replace(/\s+/g, ' ');
const text = (v, max = LIMITS.text) => String(v == null ? '' : v).slice(0, max);
const sessions = (v) => (Array.isArray(v) ? v.slice(0, 11).map((s) => text(s, 40)).filter(Boolean) : []);

// choice 요청의 질문 목록을 검사한다(AskUserQuestion과 같은 모양)
function readQuestions(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('questions가 비어 있음');
  if (list.length > LIMITS.questions) throw new Error(`질문은 ${LIMITS.questions}개까지`);
  return list.map((q, i) => {
    if (!q || !String(q.question || '').trim()) throw new Error(`${i + 1}번 질문 문장이 없음`);
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length < LIMITS.optionsMin || options.length > LIMITS.optionsMax) throw new Error(`${i + 1}번 질문의 선택지는 ${LIMITS.optionsMin}~${LIMITS.optionsMax}개`);
    const labels = options.map((o) => text(o && o.label, 120).trim());
    if (labels.some((l) => !l)) throw new Error(`${i + 1}번 질문에 제목 없는 선택지가 있음`);
    if (new Set(labels).size !== labels.length) throw new Error(`${i + 1}번 질문의 선택지 제목이 겹침`);
    const noCost = labels.filter((l, j) => !text(options[j].cost, 500).trim());
    if (noCost.length) throw new Error(`필수 필드 누락: ${i + 1}번 질문 선택지 cost(${noCost.join(', ')})`);
    return {
      question: text(q.question, 500),
      header: text(q.header, 24),
      multiSelect: !!q.multiSelect,
      allowOther: q.allowOther !== false,
      options: options.map((o, j) => ({
        label: labels[j],
        description: text(o.description, 500),
        cost: text(o.cost, 500),
        onClick: text(o.onClick, 500),
        recommended: !!o.recommended,
      })),
    };
  });
}

// 요청 파일을 화면용 모양으로 고른다. 형식이 틀린 파일은 broken으로 남겨 화면에 알린다
function readRequest(file, id) {
  try {
    const r = readJson(file);
    if (!r || typeof r !== 'object') throw new Error('객체가 아님');
    if (!KINDS[r.kind]) throw new Error(`알 수 없는 종류: ${r.kind}`);
    // OPS-03: 카드만 보고 판단할 수 있게 무엇을·왜·누르면 무슨 일이 비면 올리지 않는다
    const missing = REQUIRED.filter((k) => !text(r[k]).trim());
    if (missing.length) throw new Error(`필수 필드 누락: ${missing.join(', ')}`);
    const base = {
      id,
      kind: r.kind,
      session: text(r.session || '(세션 미상)', 40),
      relatedSessions: sessions(r.relatedSessions),
      createdAt: r.createdAt || null,
      title: text(r.title, 300),
      detail: text(r.detail),
      what: text(r.what),
      why: text(r.why),
      onClick: text(r.onClick, 500),
      cost: text(r.cost, 500),
    };
    if (r.kind === 'choice') return { ...base, background: text(r.background), questions: readQuestions(r.questions) };
    if (r.kind === 'permission') {
      return {
        ...base,
        sessionId: text(r.sessionId, 80) || null,
        tool: text(r.tool, 80),
        command: text(r.command, 1000),
        expiresAt: r.expiresAt || null,
      };
    }
    if (r.kind === 'todo') {
      return {
        ...base,
        sessionId: text(r.sessionId, 80) || null,
        steps: Array.isArray(r.steps) ? r.steps.slice(0, 20).map((x) => text(x, 1000)) : [],
        check: text(r.check, 1000),
        // 직접 실행할 명령(분류기 거부 카드 등): 원래 셸('bash'·'powershell'·null)과, Bash면 PowerShell에 붙여 넣을 형태
        command: text(r.command, 4000),
        shell: r.shell === 'bash' || r.shell === 'powershell' ? r.shell : null,
        commandPowerShell: text(r.commandPowerShell, 5000),
        tool: text(r.tool, 80),
      };
    }
    return {
      ...base,
      branch: text(r.branch, 200),
      command: text(r.command, 1000),
      commits: Array.isArray(r.commits) ? r.commits.slice(0, 50).map((c) => ({ hash: text(c && c.hash, 40), subject: text(c && c.subject, 300) })) : [],
      files: Array.isArray(r.files) ? r.files.slice(0, 200).map((f) => text(f, 300)) : [],
      fileCount: Number.isFinite(r.fileCount) ? r.fileCount : Array.isArray(r.files) ? r.files.length : null,
      verification: text(r.verification),
    };
  } catch (err) {
    return { id, broken: err.message };
  }
}

function readState(root = ROOT) {
  const p = paths(root);
  const decisions = new Map();
  for (const f of listJson(p.decisions)) {
    try {
      decisions.set(f.slice(0, -5), readJson(path.join(p.decisions, f)));
    } catch {
      // 읽는 중 바뀐 파일은 다음 갱신에서 다시 읽는다
    }
  }
  const requests = listJson(p.requests).map((f) => readRequest(path.join(p.requests, f), f.slice(0, -5)));
  const pending = requests.filter((r) => !decisions.has(r.id) && !(r.kind === 'permission' && permissionClosed(p, r))).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const byId = new Map(requests.map((r) => [r.id, r]));
  const recent = [...decisions.entries()]
    .map(([id, d]) => ({ id, ...d, request: byId.get(id) || null }))
    .sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)))
    .slice(0, 10);
  return { root: p.root, pending, recent };
}

// 권한 카드가 더는 결정할 수 없는 상태인가: 훅이 시간 초과로 닫았거나(used) 기한이 지남
function permissionClosed(p, r, now = Date.now()) {
  return fs.existsSync(path.join(p.used, `${r.id}.json`)) || (!!r.expiresAt && Date.parse(r.expiresAt) <= now);
}

// 결정이 없는 요청 수(전환 뒤 옛 폴더에 남은 요청을 알리는 데 쓴다)
function countPending(root) {
  const p = paths(root);
  const decided = new Set(listJson(p.decisions));
  return listJson(p.requests).filter((f) => !decided.has(f)).length;
}

// 결정 파일을 쓰고 로그에 한 줄을 덧붙인다. 같은 id에 두 번 쓰지 않는다
function writeDecision(id, req, body, root) {
  const p = ensureDirs(root);
  const file = path.join(p.decisions, `${id}.json`);
  if (fs.existsSync(file)) throw new Error('이미 결정된 요청');
  const out = {
    id,
    kind: req.kind,
    session: req.session, // 결정을 전해 받을 세션. 멈춰 있으면 pm 세션이 깨워 전달한다
    relatedSessions: req.relatedSessions,
    ...body,
    by: 'user',
    decidedAt: new Date().toISOString(),
    done: true,
  };
  writeJsonAtomic(file, out);
  const line = { id, kind: out.kind, session: out.session, relatedSessions: out.relatedSessions, decision: out.decision, decidedAt: out.decidedAt };
  try {
    fs.appendFileSync(p.log, JSON.stringify(line) + '\n', 'utf8');
  } catch {
    // 로그는 알림용이다. 결정 파일이 원본이므로 로그 실패는 결정을 막지 않는다
  }
  return out;
}

function loadPending(id, root) {
  if (!ID_RE.test(String(id))) throw new Error('요청 id 형식이 잘못됨');
  const req = readRequest(path.join(paths(root).requests, `${id}.json`), id);
  if (req.broken) throw new Error('요청 파일을 읽지 못함: ' + req.broken);
  return req;
}

// git 명령 요청의 승인·거부
function decide(id, decision, { reason = '', root = ROOT } = {}) {
  if (decision !== 'approved' && decision !== 'rejected') throw new Error('결정 값이 틀림');
  if (decision === 'rejected' && !String(reason).trim()) throw new Error('거부 사유가 필요함');
  const req = loadPending(id, root);
  if (req.kind === 'choice') throw new Error('결정 요청은 선택지로 답해야 함');
  if (req.kind === 'todo') throw new Error("할 일은 '완료'로 닫아야 함");
  if (req.kind === 'permission' && permissionClosed(paths(root), req)) throw new Error('기한이 지나 이미 거부된 권한 요청');
  return writeDecision(id, req, { decision, reason: text(reason).trim(), command: normalize(req.command) }, root);
}

// choice 요청의 답. answers[i] = { selected: [선택지 제목…], other: '직접 입력' }
function answer(id, answers, { note = '', root = ROOT } = {}) {
  const req = loadPending(id, root);
  if (req.kind !== 'choice') throw new Error('선택지 결정 요청이 아님');
  if (!Array.isArray(answers) || answers.length !== req.questions.length) throw new Error('모든 질문에 답해야 함');
  const out = req.questions.map((q, i) => {
    const a = answers[i] || {};
    const labels = new Set(q.options.map((o) => o.label));
    const selected = [...new Set(Array.isArray(a.selected) ? a.selected.map(String) : [])];
    const other = q.allowOther ? text(a.other).trim() : '';
    if (selected.some((s) => !labels.has(s))) throw new Error(`${i + 1}번 질문에 없는 선택지가 있음`);
    if (!selected.length && !other) throw new Error(`${i + 1}번 질문에 답하지 않음`);
    if (!q.multiSelect && selected.length + (other ? 1 : 0) > 1) throw new Error(`${i + 1}번 질문은 하나만 고를 수 있음`);
    return { question: q.question, header: q.header, selected, other: other || null };
  });
  return writeDecision(id, req, { decision: 'answered', answers: out, note: text(note).trim() }, root);
}

// 할 일 카드를 닫는다('완료'). 세션은 결정 파일의 decision: 'done'을 보고 이어 간다(B2-3)
function markDone(id, { note = '', root = ROOT } = {}) {
  const req = loadPending(id, root);
  if (req.kind !== 'todo') throw new Error('할 일 카드가 아님');
  return writeDecision(id, req, { decision: 'done', note: text(note).trim() }, root);
}

// 권한 요청 파일(requests/perm-<key>.json) 목록. 형식: 운영 도구 구현 계획 2.2
//   [{ key, sessionId, sessionName, tool, toolInput, command, permissionMode, createdAt, expiresAt, decision: null|'approved'|'rejected'|'expired' }]
function listPermissionRequests(root = ROOT) {
  const p = paths(root);
  const out = [];
  for (const f of listJson(p.requests)) {
    const id = f.slice(0, -5);
    if (!id.startsWith('perm-')) continue;
    let r;
    try {
      r = readJson(path.join(p.requests, f));
    } catch {
      continue;
    }
    if (!r || r.kind !== 'permission') continue;
    let decision = null;
    try {
      decision = readJson(path.join(p.decisions, f)).decision || null;
    } catch {
      if (permissionClosed(p, { id, expiresAt: r.expiresAt })) decision = 'expired';
    }
    out.push({
      id,
      key: r.key || id.slice('perm-'.length),
      sessionId: r.sessionId || null,
      sessionName: r.sessionName || null,
      tool: r.tool || null,
      toolInput: r.toolInput || {},
      command: r.command || '',
      permissionMode: r.permissionMode || null,
      createdAt: r.createdAt || null,
      expiresAt: r.expiresAt || null,
      decision,
    });
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// 세션 등록 기록(sessions/<sessionId>.json, SessionStart 훅이 씀). 형식: 운영 도구 구현 계획 2.2
//   Map<sessionId, { sessionId, agentType, startedAt, cwd, source }>
function readSessionRegistry(root = ROOT) {
  const dir = path.join(root, 'sessions');
  const out = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const r = readJson(path.join(dir, f));
      if (r && typeof r.sessionId === 'string') out.set(r.sessionId, r);
    } catch {
      // 쓰는 중인 파일은 다음에 읽는다
    }
  }
  return out;
}

// 결정 파일 내용의 지문. 확장이 자기가 쓴 결정을 기억해 두었다가 출처를 대조한다(B2-1, Q3)
function decisionDigest(content) {
  return require('crypto').createHash('sha256').update(String(content).replace(/\r\n/g, '\n')).digest('hex');
}

// 결정 파일마다 { id, digest }. 출처 대조용
function listDecisionDigests(root = ROOT) {
  const p = paths(root);
  const out = [];
  for (const f of listJson(p.decisions)) {
    try {
      out.push({ id: f.slice(0, -5), digest: decisionDigest(fs.readFileSync(path.join(p.decisions, f), 'utf8')) });
    } catch {
      // 읽을 수 없으면 다음에
    }
  }
  return out;
}

module.exports = { listPermissionRequests, readSessionRegistry, decisionDigest, listDecisionDigests, ROOT, KINDS, GIT_KINDS, ROUTINE_KINDS, LIMITS, ID_RE, rootFor, paths, ensureDirs, readJson, writeJsonAtomic, readState, countPending, readRequest, decide, answer, markDone, normalize };
