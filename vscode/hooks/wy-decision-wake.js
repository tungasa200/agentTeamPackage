#!/usr/bin/env node
// Stop 훅(async + asyncRewake): 승인 센터 결정이 이 세션 앞으로 들어오면 세션을 깨운다(사용자 결정 2026-10-09 카드 20261009-2330, 안 A).
//   매 턴 끝(Stop)마다 Claude Code가 이 스크립트를 백그라운드로 띄운다. 스크립트는 decisions.log를 지켜보다가
//   이 세션 앞 결정(줄의 session = 이 세션 이름)이 보이면 stderr에 한 줄 요약을 쓰고 종료 코드 2로 끝난다 →
//   Claude Code가 그 줄을 system reminder로 보여 주며 쉬던 세션의 새 턴을 시작한다(유휴 interactive·bg 세션 모두 실측 확인).
//   멈춤 알림(kind stuck)은 relatedSessions(pm)를 깨운다 — 멈춘 세션 자신은 받을 수 없으므로.
// 지키는 것
//   - 세션당 대기 프로세스 1개: sessions/<sessionId>.wake.lock(pid). 살아 있는 대기가 있으면 새로 뜬 쪽은 바로 끝난다.
//     세션이 끝나면(claude stop·창 닫기) Claude Code가 대기 프로세스를 함께 끝낸다. 남은 잠금은 pid가 죽었으면 넘겨받는다.
//   - 한 번 알린 결정은 다시 알리지 않는다: sessions/<sessionId>.wake.json에 decisions.log를 어디까지 읽었는지(offset) 남긴다.
//     처음 뜬 세션은 로그 끝에서 시작한다(지난 결정을 몰아 알리지 않음). 깨운 턴 동안 들어온 결정은 다음 Stop의 대기가 바로 알린다.
//   - 세션 이름은 claude agents --json(공식 스크립트용 목록)에서 sessionId로 찾는다. /rename을 따라가도록 결정이 보일 때마다 다시 찾는다.
// 어떤 오류에도 세션을 막지 않는다: 알릴 것이 없거나 실패하면 종료 코드 0(출력 없음). 결정 파일·로그는 지금처럼 남는다.
const fs = require('fs');
const path = require('path');
const store = require('../approvalStore');

const POLL_MS = 2000;
const ID_RE = /^[A-Za-z0-9-]{8,80}$/;

const lockFile = (root, id) => path.join(root, 'sessions', `${id}.wake.lock`);
const stateFile = (root, id) => path.join(root, 'sessions', `${id}.wake.json`);

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// 잠금을 잡으면 true. 살아 있는 다른 대기가 잡고 있으면 false
function acquire(file, pid = process.pid) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      const other = Number(String(safeRead(file)).trim());
      if (other === pid) return true;
      if (alive(other)) return false;
      try {
        fs.rmSync(file, { force: true }); // 죽은 대기의 잠금
      } catch {
        return false;
      }
    }
  }
  return false;
}

function release(file, pid = process.pid) {
  try {
    if (Number(String(safeRead(file)).trim()) === pid) fs.rmSync(file, { force: true });
  } catch {
    // 다음 대기가 죽은 pid로 보고 넘겨받는다
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readOffset(file) {
  try {
    const n = JSON.parse(safeRead(file)).offset;
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function saveOffset(file, offset) {
  store.writeJsonAtomic(file, { offset, at: new Date().toISOString() });
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// offset부터 끝까지의 완성된 줄(마지막 줄바꿈까지)과 다음 offset
function readNewLines(file, offset) {
  const size = sizeOf(file);
  if (size < offset) offset = 0; // 로그가 비워졌거나 바뀜
  if (size === offset) return { lines: [], next: offset };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], next: offset }; // 쓰는 중인 줄
    const lines = [];
    for (const l of buf.subarray(0, end).toString('utf8').split('\n')) {
      try {
        if (l.trim()) lines.push(JSON.parse(l));
      } catch {
        // 깨진 줄은 건너뛴다
      }
    }
    return { lines, next: offset + end + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

function forMe(line, name) {
  if (!line || !name) return false;
  if (line.kind === 'stuck') return Array.isArray(line.relatedSessions) && line.relatedSessions.includes(name);
  return line.session === name;
}

const clip = (s, n = 80) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// 결정 한 줄 요약: id · kind · decision · 선택값/메모/사유 앞부분(결정 파일에서)
function summarize(root, line) {
  if (line.kind === 'stuck') return `${line.id} · stuck · ${clip(line.notice, 120)}`;
  let d = {};
  try {
    d = JSON.parse(safeRead(path.join(root, 'decisions', `${line.id}.json`)));
  } catch {
    // 로그 줄만으로 요약한다
  }
  const picked = Array.isArray(d.answers)
    ? d.answers.map((a) => [...(a.selected || []), a.other].filter(Boolean).join('+')).filter(Boolean).join(' / ')
    : '';
  const extra = clip(picked || d.note || d.reason || '');
  return [line.id, line.kind, line.decision].concat(extra ? [extra] : []).join(' · ');
}

function message(root, lines) {
  const head = `[승인 센터] 이 세션 앞 결정 ${lines.length}건이 들어왔습니다. 결정 파일(decisions/<id>.json)을 읽고 이어 가세요.`;
  return [head, ...lines.map((l) => '- ' + summarize(root, l))].join('\n');
}

// 대기 본체. 알릴 문구를 돌려주거나(깨움) 세션이 끝날 때까지 기다린다. 시험에서 listAgents·pollMs·shouldStop을 바꿔 끼운다
async function wait(input, { root, listAgents, pollMs = POLL_MS, shouldStop = () => false, parentPid = Number(process.env.CLAUDE_PID) } = {}) {
  const id = String((input && input.session_id) || '');
  if (!ID_RE.test(id)) return null;
  root = root || store.rootFor(input.cwd || process.cwd());
  const log = store.paths(root).log;
  const lock = lockFile(root, id);
  const state = stateFile(root, id);
  if (!acquire(lock)) return null;
  try {
    let offset = readOffset(state);
    if (offset === null) {
      offset = sizeOf(log);
      saveOffset(state, offset);
    }
    let name = null;
    const list = listAgents || require('../agentsReader').readAgents;
    for (;;) {
      if (shouldStop()) return null;
      if (parentPid && !alive(parentPid)) return null; // 세션이 끝났는데 남은 경우
      const { lines, next } = readNewLines(log, offset);
      if (lines.length) {
        try {
          const me = ((await list()) || []).find((s) => s && s.sessionId === id);
          name = (me && me.name) || name;
        } catch {
          // 목록을 못 읽으면 앞서 찾은 이름을 쓴다
        }
        const mine = lines.filter((l) => forMe(l, name));
        if (!name) {
          // 이름을 모르면 이 줄들을 넘기지 않고 조금 뒤 다시 본다(claude agents를 자주 부르지 않게 30초 간격)
          await sleep(pollMs * 15);
          continue;
        }
        offset = next;
        saveOffset(state, offset);
        if (mine.length) return message(root, mine);
      } else if (next !== offset) {
        offset = next;
        saveOffset(state, offset);
      }
      await sleep(pollMs);
    }
  } finally {
    release(lock);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', async () => {
    let text = null;
    try {
      text = await wait(JSON.parse(raw));
    } catch {
      text = null;
    }
    if (text) {
      process.stderr.write(text + '\n');
      process.exit(2);
    }
    process.exit(0);
  });
}

module.exports = { wait, acquire, release, readNewLines, forMe, summarize, message, alive, lockFile, stateFile };
