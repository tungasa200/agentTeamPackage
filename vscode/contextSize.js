// 세션 대화 크기(토큰) 읽기: 대화 기록(.jsonl)의 마지막 assistant 응답 usage에서
//   input_tokens + cache_read_input_tokens + cache_creation_input_tokens 를 더한다(매 턴 다시 읽는 대화 전체 크기).
// 세션 현황 대시보드·대화 크기 훅(wy-context-size.js)·테스트가 함께 쓴다. session.ps1 health도 같은 기준으로 잰다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL_BYTES = 1024 * 1024; // 마지막 응답 줄은 끝 근처에 있다. 큰 도구 결과 줄이 끼어도 넉넉하게

// 기본값: 교대 권장 15만(rotation.contextTokens), 훅 알림 20만(rotation.notifyTokens) — 사용자 결정 2026-10-07
const DEFAULTS = { contextTokens: 150000, notifyTokens: 200000 };

function thresholds(ops) {
  const r = (ops && ops.rotation) || {};
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  return { contextTokens: num(r.contextTokens, DEFAULTS.contextTokens), notifyTokens: num(r.notifyTokens, DEFAULTS.notifyTokens) };
}

// Claude Code는 대화 기록 폴더 이름을 저장소 경로의 영문·숫자 외 문자를 '-'로 바꿔 만든다
function transcriptFile(root, sessionId, home = os.homedir()) {
  if (!root || !sessionId) return null;
  return path.join(home, '.claude', 'projects', String(root).replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}

function usageTokens(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (!e || e.type !== 'assistant' || e.isSidechain) return null;
  const u = e.message && e.message.usage;
  if (!u) return null;
  const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return n > 0 ? n : null; // 합성 응답(usage 0)은 건너뛴다
}

// 파일이 없거나 응답이 아직 없으면 null
function readContextTokens(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // 잘린 첫 줄
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      const n = usageTokens(lines[i]);
      if (n) return n;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { readContextTokens, transcriptFile, thresholds, DEFAULTS };
