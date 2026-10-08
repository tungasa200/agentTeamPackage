// 생성 파일 보호(OPS-10-3): init·update가 만든 파일의 해시를 .claude/wy-ops.lock.json에 남기고,
// 다음 update 때 사람이 고친 파일(지금 해시 ≠ lock 해시)은 덮지 않고 차이만 보여 준다.
//   lock 형식: { schema: 1, version, files: { "<프로젝트 기준 상대 경로>": "<sha256>" } }
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LOCK = path.join('.claude', 'wy-ops.lock.json');
// CRLF 체크아웃(autocrlf)에서도 같은 해시가 나오게 줄바꿈을 맞춘 뒤 잰다
const hash = (text) => crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');
const rel = (root, file) => path.relative(root, path.resolve(root, file)).replace(/\\/g, '/');

function readLock(root) {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(root, LOCK), 'utf8'));
    return l && typeof l.files === 'object' ? l : { schema: 1, files: {} };
  } catch {
    return { schema: 1, files: {} };
  }
}

// 파일 하나를 어떻게 할지: create(없음) · same(내용 같음) · update(lock과 같은 상태라 덮어도 됨)
//   · modified(사람이 고침 → 덮지 않음) · unmanaged(lock에 없는데 이미 있음 → 덮지 않음, init이 남의 파일을 덮지 않게)
function decide(root, lock, file, content) {
  const key = rel(root, file);
  const full = path.join(root, key);
  if (!fs.existsSync(full)) return { file: key, action: 'create' };
  const now = hash(fs.readFileSync(full, 'utf8'));
  if (now === hash(content)) return { file: key, action: 'same' };
  const locked = lock.files[key];
  if (!locked) return { file: key, action: 'unmanaged' };
  return { file: key, action: locked === now ? 'update' : 'modified' };
}

// 계획대로 쓴다. create·update만 쓰고, 쓴 파일과 same인 파일의 해시를 lock에 남긴다
function writePlanned(root, lock, items, version) {
  const next = { schema: 1, version: version || lock.version || null, files: { ...lock.files } };
  for (const { file, content, action } of items) {
    if (action === 'create' || action === 'update') {
      const full = path.join(root, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    if (action === 'create' || action === 'update' || action === 'same') next.files[file] = hash(content);
  }
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, LOCK), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

// 생성기(gen-agents·gen-skill)가 파일을 쓴 뒤 그 항목의 해시를 지금 내용으로 맞춘다.
// 정상 생성 경로에서 lock이 어긋나지 않게(어긋나는 것은 사람이 생성물을 직접 고친 경우뿐) — 84cd6e5 뒤 11개가 어긋났던 결함(pm 결정).
// lock 파일이 없는 프로젝트(init 전)는 건드리지 않는다. 다른 항목·version은 그대로 둔다
function recordWritten(root, files) {
  const file = path.join(root, LOCK);
  if (!fs.existsSync(file)) return null;
  const l = readLock(root);
  for (const f of files) {
    const key = rel(root, f);
    const full = path.join(root, key);
    if (fs.existsSync(full)) l.files[key] = hash(fs.readFileSync(full, 'utf8'));
  }
  fs.writeFileSync(file, JSON.stringify({ schema: 1, version: l.version || null, files: l.files }, null, 2) + '\n', 'utf8');
  return l;
}

// 생성물(생성기가 만드는 파일). 역할 원본(.claude/ops/)·설정처럼 사람이 고치라고 둔 파일은 lock에 있어도(init이 덮지 않으려고 남김) 어긋남으로 보지 않는다
const GENERATED = /^\.claude\/(?:agents\/[^/]+\.md|skills\/pm-ops\/)/;

// 생성물 가운데 lock과 지금 파일이 다른 항목(사람이 직접 고쳤거나 생성 뒤 lock이 갱신되지 않음). 없는 파일은 missing
function drift(root) {
  const l = readLock(root);
  const out = [];
  for (const [key, h] of Object.entries(l.files)) {
    if (!GENERATED.test(key)) continue;
    const full = path.join(root, key);
    if (!fs.existsSync(full)) out.push({ file: key, state: 'missing' });
    else if (hash(fs.readFileSync(full, 'utf8')) !== h) out.push({ file: key, state: 'changed' });
  }
  return out;
}

module.exports = { LOCK, hash, readLock, decide, writePlanned, recordWritten, drift };
