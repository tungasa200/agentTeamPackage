// 세션 활동 읽기(OPS-09): 세션 대화 기록(~/.claude/projects/<프로젝트>/*.jsonl)에서 세션 간 메시지와
// 세션별 마지막 동작을 읽고, 메시지를 작업 ID·응답 관계로 묶는다. (운영 도구 구현 계획 3.3)
//
// 대화 기록은 Claude Code의 내부 형식이다(공개 계약 아님). 모르는 형식은 건너뛰고 unreadable로 센다.
//   받은 메시지  type:"user", origin:{kind:"peer", name, msg_id, body}
//   보낸 메시지  assistant content의 tool_use SendMessage {to, summary, message}
//                → 다음 tool_result의 toolUseResult.msg_id로 받은 쪽과 짝짓는다
//   세션 이름    type:"agent-name", agentName
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIRST_TAIL = 256 * 1024; // 처음 볼 때 파일 끝에서 읽는 양
const HEAD_FOR_NAME = 64 * 1024; // 끝부분에 이름 줄이 없으면 앞에서 찾는 양
const CHUNK = 1024 * 1024; // 한 번에 읽는 최대 크기(큰 파일을 통째로 올리지 않는다)
const MAX_AGE = 24 * 60 * 60 * 1000; // 처음 열 때 이보다 오래 손대지 않은 기록은 건너뛴다
const MAX_MESSAGES = 400;
const BAND_GAP = 90 * 1000; // 줄 사이가 이보다 짧으면 계속 일한 것으로 본다
const MAX_BANDS = 500; // 기록 하나에 남기는 구간 수
const RECENT = 3 * 60 * 60 * 1000; // 이 안에 쓴 기록은 처음에 끝부분을 4배(1MB) 읽는다

// 저장소 경로 → 대화 기록 폴더 이름(영숫자 외 문자를 '-'로): C:\projects\my-app → C--projects-my-app
function transcriptDir(repoRoot, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', path.resolve(repoRoot).replace(/[^A-Za-z0-9]/g, '-'));
}

// "XX-pm [363ba2]" → "XX-pm"
const bareName = (to) => String(to || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();

const firstLine = (text) => (String(text || '').split(/\r?\n/).find((l) => l.trim()) || '').trim();

function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, start + off);
      if (!n) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

function sendResultMsgId(block, line) {
  const r = line.toolUseResult;
  if (r && typeof r === 'object') return r.success === false ? null : r.msg_id || null;
  const c = block.content;
  const text = Array.isArray(c) ? c.map((x) => (x && x.text) || '').join('') : String(c || '');
  try {
    const j = JSON.parse(text);
    return j.success === false ? null : j.msg_id || null;
  } catch {
    return null;
  }
}

// 도구 호출 한 줄 요약(세션 칩의 "지금 하는 일")
function describeTool(b) {
  const i = b.input || {};
  if (b.name === 'SendMessage') return `${bareName(i.to)}에 메시지`;
  if (i.description) return firstLine(i.description);
  if (i.file_path) return `${b.name} ${path.basename(String(i.file_path))}`;
  if (i.pattern) return `${b.name} ${i.pattern}`;
  return b.name;
}

class ActivityReader {
  constructor({ dir, now = () => Date.now(), firstTail = FIRST_TAIL, maxAge = MAX_AGE } = {}) {
    this.dir = dir;
    this.now = now;
    this.firstTail = firstTail;
    this.maxAge = maxAge;
    this.files = new Map(); // 파일 이름 → {offset, rest, sessionId, name, pending: Map(toolUseId → 보낸 메시지)}
    this.messages = new Map(); // msg_id → 메시지
    this.sessions = new Map(); // 세션 이름 → {name, sessionId, lastAt, doing}
    this.unreadable = 0;
  }

  // 새로 붙은 줄만 읽는다. 바뀐 것이 있으면 true
  poll() {
    let names;
    try {
      names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return false;
    }
    let changed = false;
    for (const f of names) {
      try {
        if (this.readFile(f)) changed = true;
      } catch {
        // 읽는 중에 지워지거나 잠긴 파일은 다음 주기에 다시 본다
      }
    }
    return changed;
  }

  readFile(f) {
    const file = path.join(this.dir, f);
    const st = fs.statSync(file);
    let s = this.files.get(f);
    if (!s) {
      const age = this.now() - st.mtimeMs;
      if (age > this.maxAge) return false;
      const tail = age < RECENT ? this.firstTail * 4 : this.firstTail; // 최근에 쓴 기록은 시간 보기의 띠가 비지 않게 더 읽는다
      s = { offset: Math.max(0, st.size - tail), rest: '', skipFirst: st.size > tail, sessionId: f.replace(/\.jsonl$/, ''), name: null, pending: new Map(), bands: [] };
      this.files.set(f, s);
      if (s.skipFirst) s.name = this.nameFromHead(file, st.size);
    }
    if (st.size < s.offset) Object.assign(s, { offset: 0, rest: '', skipFirst: false }); // 잘리거나 새로 쓰인 파일
    if (st.size === s.offset) return false;
    let changed = false;
    while (s.offset < st.size) {
      const end = Math.min(st.size, s.offset + CHUNK);
      const text = s.rest + readRange(file, s.offset, end).toString('utf8');
      s.offset = end;
      const lines = text.split('\n');
      s.rest = lines.pop(); // 아직 덜 쓴 줄
      if (s.skipFirst) {
        lines.shift(); // 끝부분부터 읽으면 첫 줄은 잘려 있다
        s.skipFirst = false;
      }
      for (const l of lines) if (l.trim() && this.readLine(s, l)) changed = true;
    }
    return changed;
  }

  nameFromHead(file, size) {
    const head = readRange(file, 0, Math.min(size, HEAD_FOR_NAME)).toString('utf8').split('\n');
    for (const l of head) {
      if (!l.includes('"agent-name"')) continue;
      try {
        const o = JSON.parse(l);
        if (o.agentName) return o.agentName;
      } catch {
        // 잘린 줄
      }
    }
    return null;
  }

  readLine(s, l) {
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      this.unreadable += 1;
      return false;
    }
    if (!o || typeof o !== 'object') return false;
    if (o.type === 'agent-name') {
      if (typeof o.agentName !== 'string') return this.bad();
      s.name = o.agentName;
      if (o.sessionId) s.sessionId = o.sessionId;
      return false;
    }
    if (o.isSidechain) return false; // 하위 에이전트 대화는 세션 간 메시지가 아니다
    if (o.type === 'user' && o.origin && o.origin.kind === 'peer') return this.received(s, o);
    if ((o.type === 'assistant' || o.type === 'user') && o.timestamp) this.band(s, Date.parse(o.timestamp));
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) return false;
    let changed = false;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (o.type === 'assistant' && b.type === 'tool_use') {
        this.touch(s, o.timestamp, describeTool(b));
        changed = true;
        if (b.name === 'SendMessage') {
          const i = b.input || {};
          if (!i.to || typeof i.message !== 'string') this.bad();
          else s.pending.set(b.id, { to: bareName(i.to), summary: i.summary || '', body: i.message, at: o.timestamp });
        }
      } else if (o.type === 'user' && b.type === 'tool_result' && s.pending.has(b.tool_use_id)) {
        const sent = s.pending.get(b.tool_use_id);
        s.pending.delete(b.tool_use_id);
        const id = sendResultMsgId(b, o);
        if (id) changed = this.add({ id, from: s.name, to: sent.to, at: sent.at, summary: sent.summary, body: sent.body }) || changed;
      }
    }
    return changed;
  }

  received(s, o) {
    const g = o.origin;
    if (!g.msg_id || !g.name || typeof g.body !== 'string') return this.bad();
    return this.add({ id: g.msg_id, from: g.name, to: s.name, at: o.timestamp, summary: '', body: g.body });
  }

  bad() {
    this.unreadable += 1;
    return false;
  }

  // 일한 구간: 대화 줄(응답·도구 결과)이 BAND_GAP 안으로 이어지면 한 구간이다(시간 보기의 띠)
  band(s, t) {
    if (!Number.isFinite(t)) return;
    if (!s.firstAt || t < s.firstAt) s.firstAt = t; // 읽은 기록의 시작(이 앞은 처음 열 때 읽지 않았다)
    const last = s.bands[s.bands.length - 1];
    if (last && t >= last[0] && t - last[1] <= BAND_GAP) last[1] = Math.max(last[1], t);
    else s.bands.push([t, t]);
    if (s.bands.length > MAX_BANDS) s.bands.shift();
  }

  // since 이후 세션 이름별 일한 구간. 같은 이름의 여러 기록(다시 띄운 세션)은 합친다.
  // from: 그 이름의 기록을 읽기 시작한 가장 이른 시각(이보다 앞은 모름)
  bandsSince(since) {
    const byName = new Map();
    const from = new Map();
    for (const s of this.files.values()) {
      if (!s.name || !s.firstAt) continue;
      const list = byName.get(s.name) || [];
      for (const b of s.bands) if (b[1] >= since) list.push([Math.max(b[0], since), b[1]]);
      byName.set(s.name, list);
      from.set(s.name, Math.min(from.get(s.name) || Infinity, s.firstAt));
    }
    const out = [];
    for (const [name, list] of byName) {
      list.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const b of list) {
        const last = merged[merged.length - 1];
        if (last && b[0] - last[1] <= BAND_GAP) last[1] = Math.max(last[1], b[1]);
        else merged.push([b[0], b[1]]);
      }
      out.push({ name, bands: merged, from: from.get(name) });
    }
    return out;
  }

  touch(s, at, doing) {
    if (!s.name || !at) return;
    const cur = this.sessions.get(s.name);
    if (cur && cur.lastAt > at) return;
    this.sessions.set(s.name, { name: s.name, sessionId: s.sessionId, lastAt: at, doing });
  }

  // 받은 쪽·보낸 쪽 기록을 msg_id로 합친다: 시각은 보낸 시각(이른 쪽), 요약은 보낸 쪽 summary
  add(m) {
    const cur = this.messages.get(m.id);
    if (!cur) {
      this.messages.set(m.id, m);
      this.trim();
      return true;
    }
    const merged = {
      ...cur,
      from: cur.from || m.from,
      to: cur.to || m.to,
      at: [cur.at, m.at].filter(Boolean).sort()[0],
      summary: cur.summary || m.summary,
      body: cur.body.length >= m.body.length ? cur.body : m.body,
    };
    const changed = JSON.stringify(merged) !== JSON.stringify(cur);
    this.messages.set(m.id, merged);
    return changed;
  }

  trim() {
    if (this.messages.size <= MAX_MESSAGES) return;
    const old = [...this.messages.values()].sort((a, b) => (a.at < b.at ? -1 : 1)).slice(0, this.messages.size - MAX_MESSAGES);
    for (const m of old) this.messages.delete(m.id);
  }

  // 시간순(오래된 것 먼저) 메시지. title은 요약(보낸 쪽 summary, 없으면 첫 줄)
  feed() {
    return [...this.messages.values()]
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .map((m) => ({ ...m, from: m.from || '(알 수 없음)', to: m.to || '(알 수 없음)', title: m.summary || firstLine(m.body) }));
  }

  lastActions() {
    return [...this.sessions.values()];
  }
}

// --- 묶음(결함 흐름 등) ---

// 메시지 앞부분에서 처음 나오는 작업 ID. 세 마디 ID(P1-09-09)를 두 마디(P1-09)보다 먼저 본다
const ID_RE = /\b(P\d+-\d+(?:-\d+)?|TC-[A-Za-z0-9-]+|D-\d+|OPS-\d+|U-\d+|B\d-\d)\b/;
const HEAD = 400;

// 머리표 → 단계 종류. 앞에 있는 것이 먼저
const STAGES = [
  ['bug', /\[결함\]/],
  ['block', /\[차단\]/],
  ['ask', /\[결정 요청\]|결정 카드/],
  ['done', /\[완료\]|재검증\s*통과/],
  ['commit', /커밋 요청|\[커밋/],
  ['verify', /재검증/],
];

function stageOf(m) {
  const head = `${m.summary || ''}\n${String(m.body).slice(0, HEAD)}`;
  for (const [k, re] of STAGES) if (re.test(head)) return k;
  return 'order';
}

function taskId(m) {
  const hit = `${m.summary || ''}\n${String(m.body).slice(0, HEAD)}`.match(ID_RE);
  return hit ? hit[1] : null;
}

const PAIR_GAP = 60 * 60 * 1000; // ID 없는 메시지: 같은 두 세션 사이에서 이 간격 안이면 같은 묶음(응답 관계)

// 묶음 상태: 마지막 단계로 정한다
function bundleState(stages) {
  const last = stages[stages.length - 1];
  if (last === 'done') return 'done';
  if (last === 'block') return 'blocked';
  if (last === 'ask') return 'ask';
  if (last === 'bug') return 'bug';
  return 'run';
}

const stripTag = (t) => String(t).replace(/^\s*(\[[^\]]+\]\s*)+/, '').replace(/^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+\s*(지시|알림)?\s*:\s*/, '').trim();

// feed(시간순) → 묶음(최근에 움직인 것 먼저)
function bundle(feed) {
  const byKey = new Map();
  const openPairs = new Map(); // "A|B" → 마지막 ID 없는 묶음
  for (const m of feed) {
    const id = taskId(m);
    let key;
    if (id) key = `id:${id}`;
    else {
      const pair = [m.from, m.to].sort().join('|');
      const prev = openPairs.get(pair);
      // 응답이 [완료]로 끝났으면 다음 메시지는 새 묶음이다(ID 없는 대화가 몇 시간씩 이어 붙지 않게)
      const open = prev && prev.stages[prev.stages.length - 1] !== 'done' && Date.parse(m.at) - Date.parse(prev.lastAt) <= PAIR_GAP;
      key = open ? prev.key : `pair:${pair}:${m.at}`;
    }
    let b = byKey.get(key);
    if (!b) {
      b = { key, taskId: id, title: id ? `${id} ${stripTag(m.title).replace(id, '').trim()}`.trim() : stripTag(m.title), startedAt: m.at, lastAt: m.at, messages: [], stages: [] };
      byKey.set(key, b);
    }
    b.messages.push(m);
    b.stages.push(stageOf(m));
    b.lastAt = m.at;
    if (!id) openPairs.set([m.from, m.to].sort().join('|'), b);
  }
  return [...byKey.values()]
    .map((b) => ({ ...b, state: bundleState(b.stages), sessions: [...new Set(b.messages.flatMap((m) => [m.from, m.to]))] }))
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

module.exports = { ActivityReader, transcriptDir, bundle, stageOf, taskId, bareName };
