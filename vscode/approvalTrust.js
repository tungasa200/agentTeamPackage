// 승인 센터 기기 신뢰(출처 대조, 접속 기기 N대). 승인 센터 창이 여러 기기(호스트 창, Remote-SSH 노트북 창…)에 떠 있어도
// 서로 쓴 결정을 '출처 불명'으로 띄우지 않으면서, 세션이 직접 만든 결정은 계속 잡는다.
// - 키는 기기 단위 Ed25519. 개인키는 그 기기의 VS Code globalState에만 둔다(같은 기기의 창은 함께 쓴다).
// - 공유 파일은 decisions/trust/ 아래(가드 훅이 세션의 decisions/ 쓰기를 막는다):
//     devices.json  기기 명부: 서명한 진술 목록 [{ type: 'root'|'add'|'revoke', …, by, sig }]
//     sigs/<id>.json 결정 서명 { id, digest, fp, sig }
//     join/<fp>.json 등록 요청(확장이 쓴다) { pub, name, at, sig(자기 서명) }
// - 신뢰의 기준은 각 기기 globalState에 고정한 뿌리(anchors)와 자기 키다. 공유 파일만으로는 신뢰가 생기지 않는다.
//   신뢰하는 키가 서명해 보증(add)한 키도 신뢰한다(사슬). 해제(revoke)는 그때 그 키로 서명돼 있던 결정·보증 목록만 계속 인정한다.
// vscode에 의존하지 않아 doctor와 시험에서도 쓴다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./approvalStore');

const FP_RE = /^[0-9a-f]{64}$/;

function trustPaths(root) {
  const dir = path.join(store.paths(root).decisions, 'trust');
  return { dir, devices: path.join(dir, 'devices.json'), sigs: path.join(dir, 'sigs'), join: path.join(dir, 'join') };
}

// ---- 키 ----
function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

function fingerprint(pub) {
  return crypto.createHash('sha256').update(Buffer.from(String(pub), 'base64')).digest('hex');
}

// 화면에 보이는 지문: 앞 16자를 넷씩
const shortFp = (fp) => String(fp).slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ');

// 서명 대상: sig를 뺀 필드를 이름순으로
function canon(obj) {
  return JSON.stringify(Object.keys(obj).filter((k) => k !== 'sig').sort().map((k) => [k, obj[k]]));
}

function sign(key, obj) {
  const k = crypto.createPrivateKey({ key: Buffer.from(key.priv, 'base64'), format: 'der', type: 'pkcs8' });
  return { ...obj, sig: crypto.sign(null, Buffer.from(canon(obj)), k).toString('base64') };
}

function verify(pub, obj) {
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(String(pub), 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canon(obj)), k, Buffer.from(String(obj.sig || ''), 'base64'));
  } catch {
    return false;
  }
}

// ---- 공유 파일 ----
function readRoster(root) {
  try {
    const r = store.readJson(trustPaths(root).devices);
    return Array.isArray(r.entries) ? r.entries.filter((e) => e && typeof e === 'object') : [];
  } catch {
    return [];
  }
}

function writeRoster(root, entries, { create = false } = {}) {
  const t = trustPaths(root);
  fs.mkdirSync(t.dir, { recursive: true });
  const body = JSON.stringify({ schema: 1, entries }, null, 2) + '\n';
  if (create) {
    // 두 창이 동시에 처음 뜨면 먼저 만든 쪽이 뿌리가 된다
    try {
      fs.writeFileSync(t.devices, body, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }
  store.writeJsonAtomic(t.devices, { schema: 1, entries });
  return true;
}

function appendStatement(root, stmt) {
  writeRoster(root, [...readRoster(root), stmt]);
}

function readSigs(root) {
  const dir = trustPaths(root).sigs;
  const out = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const s = store.readJson(path.join(dir, f));
      if (s && s.id === f.slice(0, -5)) out.set(s.id, s);
    } catch {
      // 깨진 서명은 없는 것으로
    }
  }
  return out;
}

function readJoins(root) {
  const dir = trustPaths(root).join;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const j = store.readJson(path.join(dir, f));
      const fp = fingerprint(j.pub);
      // 자기 키로 서명한 요청만(개인키를 가진 기기가 낸 요청)
      if (f === `${fp}.json` && verify(j.pub, j)) out.push({ fp, pub: j.pub, name: String(j.name || '').slice(0, 60), at: j.at });
    } catch {
      // 깨진 요청은 건너뛴다
    }
  }
  return out;
}

// ---- 신뢰 계산 ----
// self: 이 기기 키 { pub }, anchors: [{ fp, pub }](globalState에 고정한 뿌리)
// 돌려줌: devices(명부의 기기, 상태 포함), trusted(Set fp), revoked(Map fp → 해제 진술), selfFp, selfStatus
function evaluate(entries, self, anchors = []) {
  const pubs = new Map(); // fp → pub (명부에 나온 키)
  const meta = new Map(); // fp → { name, at, by }
  for (const e of entries) {
    if ((e.type === 'root' || e.type === 'add') && typeof e.pub === 'string') {
      const fp = fingerprint(e.pub);
      if (!pubs.has(fp)) {
        pubs.set(fp, e.pub);
        meta.set(fp, { name: String(e.name || '').slice(0, 60), at: e.at || null, by: e.by || null });
      }
    }
  }
  const selfFp = self ? fingerprint(self.pub) : null;
  const base = new Map();
  if (self) base.set(selfFp, self.pub);
  for (const a of anchors) if (a && a.pub && fingerprint(a.pub) === a.fp) base.set(a.fp, a.pub);

  // 보증 사슬의 닫힘. allowAdd(e, signerFp)가 false인 보증은 세지 않는다
  const closure = (start, allowAdd) => {
    const t = new Map(start);
    for (let changed = true; changed; ) {
      changed = false;
      for (const e of entries) {
        if (e.type !== 'add' || typeof e.pub !== 'string') continue;
        const fp = fingerprint(e.pub);
        if (t.has(fp) || !t.has(e.by) || !allowAdd(e, e.by, fp)) continue;
        if (verify(t.get(e.by), e)) {
          t.set(fp, e.pub);
          changed = true;
        }
      }
    }
    return t;
  };

  // 1) 해제를 빼고 닫힘 → 그 안의 키가 서명한 해제만 인정
  const first = closure(base, () => true);
  const revoked = new Map();
  for (const e of entries) {
    if (e.type !== 'revoke' || !FP_RE.test(String(e.fp)) || e.by === e.fp || !first.has(e.by)) continue;
    if (verify(first.get(e.by), e) && !revoked.has(e.fp)) revoked.set(e.fp, e);
  }
  // 2) 해제된 키를 빼고 다시 닫힘. 해제된 키의 보증은 해제 때 남긴 목록(keepDevices)에 있는 것만
  const start = new Map([...base].filter(([fp]) => fp === selfFp || !revoked.has(fp)));
  const trusted = closure(start, (e, by, fp) => !revoked.has(by) || (revoked.get(by).keepDevices || []).includes(fp));
  for (const fp of revoked.keys()) if (fp !== selfFp) trusted.delete(fp);

  // 이 기기가 등록돼 있는가: 자기 키를 빼고 고정 뿌리에서 사슬이 닿는가(자기 보증은 세지 않는다)
  const others = new Map([...start].filter(([fp]) => fp !== selfFp));
  const selfEndorsed = !!self && (anchors.some((a) => a.fp === selfFp) || closure(others, (e, by, fp) => !revoked.has(by) || (revoked.get(by).keepDevices || []).includes(fp)).has(selfFp));
  let selfStatus = 'unpaired'; // 명부를 아직 신뢰하지 않음(뿌리 고정 전)
  if (self && revoked.has(selfFp)) selfStatus = 'revoked';
  else if (selfEndorsed) selfStatus = 'member';
  else if (anchors.length) selfStatus = 'pending'; // 뿌리는 고정, 등록 승인 대기

  const devices = [...pubs.keys()].map((fp) => ({
    fp,
    short: shortFp(fp),
    name: meta.get(fp).name,
    at: meta.get(fp).at,
    by: meta.get(fp).by,
    byName: meta.get(meta.get(fp).by) ? meta.get(meta.get(fp).by).name : null,
    self: fp === selfFp,
    state: revoked.has(fp) ? 'revoked' : trusted.has(fp) ? 'trusted' : 'unknown',
  }));
  return { devices, trusted, revoked, pubs, selfFp, selfStatus };
}

// 결정 하나의 서명이 이 기기 기준으로 유효한가
function sigTrusted(sig, digest, ev) {
  if (!sig || sig.digest !== digest || !FP_RE.test(String(sig.fp))) return false;
  const rv = ev.revoked.get(sig.fp);
  if (rv) {
    if (!(rv.keep || []).some((k) => k && k.id === sig.id && k.digest === digest)) return false;
    return ev.pubs.has(sig.fp) && verify(ev.pubs.get(sig.fp), sig);
  }
  return ev.trusted.has(sig.fp) && verify(ev.trusted.get(sig.fp), sig);
}

// ---- 동작 ----
function signDecision(root, key, id, digest) {
  const t = trustPaths(root);
  fs.mkdirSync(t.sigs, { recursive: true });
  store.writeJsonAtomic(path.join(t.sigs, `${id}.json`), sign(key, { id, digest, fp: fingerprint(key.pub), at: new Date().toISOString() }));
}

// 명부가 없으면 자기를 뿌리로 만든다. 만들었으면 true
function ensureRoot(root, key, name) {
  if (readRoster(root).length) return false;
  const stmt = sign(key, { type: 'root', pub: key.pub, name, at: new Date().toISOString(), by: fingerprint(key.pub) });
  return writeRoster(root, [stmt], { create: true });
}

// 명부의 첫 뿌리(자기 서명이 맞는 것). 새 기기가 지문을 비교해 고정한다
function rosterRoot(entries) {
  for (const e of entries) {
    if (e.type === 'root' && typeof e.pub === 'string' && e.by === fingerprint(e.pub) && verify(e.pub, e)) return { fp: e.by, pub: e.pub, name: String(e.name || '').slice(0, 60) };
  }
  return null;
}

function requestJoin(root, key, name) {
  const t = trustPaths(root);
  fs.mkdirSync(t.join, { recursive: true });
  store.writeJsonAtomic(path.join(t.join, `${fingerprint(key.pub)}.json`), sign(key, { pub: key.pub, name, at: new Date().toISOString() }));
}

function removeJoin(root, fp) {
  if (!FP_RE.test(String(fp))) return;
  try {
    fs.unlinkSync(path.join(trustPaths(root).join, `${fp}.json`));
  } catch {
    // 이미 없음
  }
}

function approveJoin(root, key, join) {
  appendStatement(root, sign(key, { type: 'add', pub: join.pub, name: join.name, at: new Date().toISOString(), by: fingerprint(key.pub) }));
  removeJoin(root, join.fp);
}

// 해제: 그때 그 키로 서명돼 있던(내용이 그대로인) 결정과 그 키가 보증한 기기 목록을 함께 남긴다
function revokeDevice(root, key, fp, digests) {
  const sigs = readSigs(root);
  const now = new Map(digests.map((d) => [d.id, d.digest]));
  const keep = [...sigs.values()].filter((s) => s.fp === fp && now.get(s.id) === s.digest).map((s) => ({ id: s.id, digest: s.digest }));
  const keepDevices = readRoster(root).filter((e) => e.type === 'add' && e.by === fp && e.pub).map((e) => fingerprint(e.pub));
  appendStatement(root, sign(key, { type: 'revoke', fp, keep, keepDevices, at: new Date().toISOString(), by: fingerprint(key.pub) }));
}

// doctor용 요약: 기기의 고정 뿌리 대신 명부의 첫 뿌리를 기준으로 센다(뿌리 자체가 맞는지는 승인 센터의 지문 비교가 본다)
function summary(root) {
  const entries = readRoster(root);
  const r = rosterRoot(entries);
  if (!r) return { devices: 0, revoked: 0, unknown: 0, joins: 0 };
  const ev = evaluate(entries, null, [r]);
  const known = (fp) => ev.trusted.has(fp) || ev.revoked.has(fp);
  return {
    devices: ev.trusted.size,
    revoked: ev.devices.filter((d) => d.state === 'revoked').length,
    unknown: ev.devices.filter((d) => d.state === 'unknown').length,
    joins: readJoins(root).filter((j) => !known(j.fp)).length,
  };
}

module.exports = { trustPaths, newKey, fingerprint, shortFp, sign, verify, readRoster, readSigs, readJoins, evaluate, sigTrusted, signDecision, ensureRoot, rosterRoot, requestJoin, removeJoin, approveJoin, revokeDevice, summary };
