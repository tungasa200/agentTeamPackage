// 개인 이전 묶음(K4, D-128): git 밖 개인 상태를 로컬 zip 하나로 내보내고 다른 PC(다른 사용자 이름·프로젝트 경로)에 들여온다.
//   exportState({ project, out, home?, include? }) → { file, files, skipped, redacted, plugins }
//   importState({ project, zip, home?, dryRun?, include? }) → { files, skipped, backupDir, markedUsed, reenter, plugins, source }
// 확인 질문·출력은 install.js 디스패처(export·import·restore)가 맡고, 여기서는 파일만 읽고 쓴다.
//
// 담는 것(kind → 원래 위치, zip 안 이름은 <kind>/<rel>):
//  프로젝트
//   memory        ~/.claude/projects/<프로젝트 키>/memory/**
//   approvals     ~/.claude/wy-approvals/<namespace>/ requests/·decisions/·used/·decisions.log·message-blocks.log (sessions/는 뺀다: 살아 있는 세션 대장)
//   handoff       ~/.claude/session-data/*.tmp 중 머리말(Worktree·Project)이 이 프로젝트인 것
//   settingsLocal <프로젝트>/.claude/settings.local.json   기본으로 넣음(include.settingsLocal: false로 끔)
//   transcripts   ~/.claude/projects/<프로젝트 키>/*.jsonl 기본 꺼짐(사용자 결정 2026-10-09: 넣지 않음). include.transcripts: true일 때만
//  전역(카드 1020, include.global: false로 끔)
//   claudeMd      ~/.claude/CLAUDE.md
//   skills·agents·hooks  ~/.claude/<같은 이름>/** (node_modules·.git·__pycache__·.venv는 뺀다)
//   globalSettings ~/.claude/settings.json·settings.local.json
//   mcp           ~/.claude.json의 mcpServers(사용자 범위와 프로젝트별)만 뽑는다. 들일 때 대상 ~/.claude.json에 병합한다(통째로 쓰지 않음)
// 계속 빼는 것: .credentials.json, 캐시·로그·telemetry·history·대화, secretsDir(비밀값은 손으로 따로 복사, 카드 1030).
// 플러그인·마켓 목록은 manifest에 정보로도 넣는다(설치는 install global이 맡음).
//
// 비밀값: secretsDir는 읽지 않는다. 파일 이름(.env·키 파일)과 내용(토큰·키 모양) 검사에 걸리면 그 파일을 빼고 skipped에 이유를 남긴다(값은 남기지 않음).
//   설정 JSON(settingsLocal·globalSettings·mcp)은 파일을 빼지 않고 값만 PLACEHOLDER로 바꾼다: env·headers의 모든 값, 비밀값 같은 이름의 키, 토큰 모양 문자열.
//   들일 때 대상에 같은 자리의 실제 값이 있으면 그것을 살리고, 남은 자리표시는 reenter(다시 입력할 항목)로 돌려준다.
// 경로: 설정 JSON 안의 원래 홈·프로젝트 경로는 들일 때 새 경로로 바꾼다. 나머지 파일은 내용을 그대로 둔다(해시 그대로).
// 승인 이력: 들여온 결정마다 used 표시를 함께 써서 새 PC에서 승인으로 다시 쓰이지 않게 한다(카드 0950 ①안 확정, OPS-10-3의 import 예외).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { zip } = require('./zip');
const { loadOpsConfig } = require('../vscode/opsConfig');

const PROJECT_KINDS = ['memory', 'approvals', 'handoff', 'transcripts', 'settingsLocal'];
const GLOBAL_KINDS = ['claudeMd', 'skills', 'agents', 'hooks', 'globalSettings', 'mcp'];
const KINDS = [...PROJECT_KINDS, ...GLOBAL_KINDS];
const JSON_KINDS = new Set(['settingsLocal', 'globalSettings', 'mcp']);
const APPROVAL_DIRS = ['requests', 'decisions', 'used'];
const APPROVAL_FILES = ['decisions.log', 'message-blocks.log'];
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PLACEHOLDER = '<새 PC에서 다시 입력>';

// Claude Code가 ~/.claude/projects/ 아래 폴더 이름으로 쓰는 변환(C:\projects\my-app → C--projects-my-app)
const projectKey = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function opsOf(project) {
  const ops = loadOpsConfig(project);
  const ns = ops && ops.approvals && ops.approvals.namespace;
  return { namespace: typeof ns === 'string' && ID_RE.test(ns) ? ns : null, secretsDir: (ops && typeof ops.secretsDir === 'string' && ops.secretsDir) || null };
}

function roots({ home, project, namespace }) {
  const claude = path.join(home, '.claude');
  const proj = path.join(claude, 'projects', projectKey(project));
  return {
    memory: path.join(proj, 'memory'),
    approvals: namespace ? path.join(claude, 'wy-approvals', namespace) : null,
    handoff: path.join(claude, 'session-data'),
    transcripts: proj,
    settingsLocal: path.join(project, '.claude'),
    claudeMd: claude,
    skills: path.join(claude, 'skills'),
    agents: path.join(claude, 'agents'),
    hooks: path.join(claude, 'hooks'),
    globalSettings: claude,
    mcp: home, // rel은 .claude.json(병합 대상)
  };
}

// ---- 비밀값 검사 ----
const SECRET_NAME = [
  [/(^|\/)\.env(\.|$)/i, '.env 파일'],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, '키 파일'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i, 'SSH 키'],
  [/(^|\/)\.credentials\.json$/i, '로그인 정보'],
];
const SECRET_TEXT = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '개인 키'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS 키'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub 토큰'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'GitHub 토큰'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic 키'],
  [/\bsk-(?:proj-)?[A-Za-z0-9]{32,}/, 'API 키'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack 토큰'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API 키'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, 'Bearer 토큰'],
  // 이름=값 모양. 값이 자리표시(${X}, <X>, ***, process.env…)면 넘어간다
  [/\b(?:password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)\b["']?\s*[:=]\s*["']?(?!\$\{|<|\*{3}|process\.env|env\.)[A-Za-z0-9_\-+/=.!@#%^&]{12,}/i, '비밀값 대입'],
];
// 설정 JSON에서 값을 지울 키 이름
const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|authorization|cookie/i;

function secretReason(name, buf) {
  for (const [re, why] of SECRET_NAME) if (re.test(name)) return why;
  const text = buf.toString('utf8');
  for (const [re, why] of SECRET_TEXT) if (re.test(text)) return why;
  return null;
}

// 설정 JSON의 비밀값 자리를 PLACEHOLDER로 바꾸고, 바꾼 자리(키 경로 배열)를 모은다
function redact(value, keyPath = [], out = [], under = false) {
  if (typeof value === 'string') {
    const last = String(keyPath[keyPath.length - 1] || '');
    if (value !== PLACEHOLDER && (under || SECRET_KEY.test(last) || SECRET_TEXT.some(([re]) => re.test(value)))) {
      out.push(keyPath);
      return PLACEHOLDER;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => redact(v, [...keyPath, i], out, under));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = redact(v, [...keyPath, k], out, under || k === 'env' || k === 'headers');
    return o;
  }
  return value;
}

const getAt = (obj, keyPath) => keyPath.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
function setAt(obj, keyPath, v) {
  let o = obj;
  for (const k of keyPath.slice(0, -1)) o = o[k];
  o[keyPath[keyPath.length - 1]] = v;
}
// 자리표시마다 대상(기존 값)에 실제 값이 있으면 살리고, 남은 자리를 돌려준다
function restoreFrom(data, existing) {
  const left = [];
  (function walk(v, keyPath) {
    if (v === PLACEHOLDER) {
      const e = getAt(existing, keyPath);
      if (typeof e === 'string' && e !== PLACEHOLDER) setAt(data, keyPath, e);
      else left.push(keyPath);
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...keyPath, Array.isArray(v) ? Number(k) : k]);
  })(data, []);
  return left;
}

// ---- 모으기 ----
function walk(dir, base = dir, out = []) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(d.name)) walk(p, base, out);
    } else if (d.isFile()) out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

function handoffMatches(file, project) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.slice(0, n).toString('utf8');
  } catch {
    return false;
  }
  const wt = head.match(/\*\*Worktree:\*\*\s*(.+)/);
  if (wt) {
    const w = norm(wt[1].trim());
    const p = norm(project);
    return w === p || w.startsWith(p + '/');
  }
  const pj = head.match(/\*\*Project:\*\*\s*(.+)/);
  return !!pj && pj[1].trim().toLowerCase() === path.basename(path.resolve(project)).toLowerCase();
}

const existing = (dir, names) => names.filter((n) => fs.existsSync(path.join(dir, n)));

function collect(kind, r, project) {
  const dir = r[kind];
  if (!dir) return [];
  switch (kind) {
    case 'approvals':
      return [...APPROVAL_DIRS.flatMap((d) => walk(path.join(dir, d)).map((f) => `${d}/${f}`)), ...existing(dir, APPROVAL_FILES)];
    case 'handoff':
      return walk(dir).filter((f) => !f.includes('/') && f.endsWith('.tmp') && handoffMatches(path.join(dir, f), project));
    case 'transcripts':
      return walk(dir).filter((f) => !f.includes('/') && f.endsWith('.jsonl'));
    case 'settingsLocal':
      return existing(dir, ['settings.local.json']);
    case 'claudeMd':
      return existing(dir, ['CLAUDE.md']);
    case 'globalSettings':
      return existing(dir, ['settings.json', 'settings.local.json']);
    case 'mcp':
      return existing(dir, ['.claude.json']);
    default: // memory, skills, agents, hooks
      return walk(dir);
  }
}

const readJsonFile = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

// ~/.claude.json에서 mcpServers만: { user: {...}, projects: { <경로>: {...} } }
function pickMcp(file) {
  const j = readJsonFile(file);
  const projects = {};
  for (const [k, v] of Object.entries(j.projects || {})) if (v && v.mcpServers && Object.keys(v.mcpServers).length) projects[k] = v.mcpServers;
  return { user: j.mcpServers || {}, projects };
}

function readPlugins(home) {
  try {
    const s = readJsonFile(path.join(home, '.claude', 'settings.json'));
    return { enabledPlugins: s.enabledPlugins || {}, marketplaces: Object.keys(s.extraKnownMarketplaces || {}) };
  } catch {
    return null;
  }
}

function repoInfo(project) {
  const git = (args) => {
    try {
      return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null;
    } catch {
      return null;
    }
  };
  return { remote: git(['remote', 'get-url', 'origin']), branch: git(['branch', '--show-current']) };
}

function kindsFor(include = {}) {
  return KINDS.filter((k) => {
    if (k === 'transcripts') return !!include.transcripts;
    if (k === 'settingsLocal') return include.settingsLocal !== false;
    if (GLOBAL_KINDS.includes(k)) return include.global !== false;
    return true;
  });
}

function exportState({ project, out, home = os.homedir(), include = {} }) {
  project = path.resolve(project);
  const { namespace, secretsDir } = opsOf(project);
  const r = roots({ home, project, namespace });
  const entries = [];
  const files = [];
  const skipped = [];
  const redacted = [];
  for (const kind of kindsFor(include)) {
    for (const rel of collect(kind, r, project)) {
      const src = path.join(r[kind], rel);
      let data = fs.readFileSync(src);
      let name = `${kind}/${rel}`;
      if (JSON_KINDS.has(kind)) {
        let obj;
        try {
          obj = kind === 'mcp' ? pickMcp(src) : readJsonFile(src);
        } catch {
          skipped.push({ kind, rel, reason: 'JSON을 읽지 못함' });
          continue;
        }
        if (kind === 'mcp') name = 'mcp/mcpServers.json';
        const keys = [];
        obj = redact(obj, [], keys);
        for (const k of keys) redacted.push({ kind, rel, key: k.join('.') });
        data = Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');
      }
      const why = secretReason(rel, data);
      if (why) {
        skipped.push({ kind, rel, reason: `비밀값으로 보임(${why})` });
        continue;
      }
      entries.push({ name, data });
      files.push({ name, kind, rel, sha256: sha256(data), size: data.length, mtime: fs.statSync(src).mtime.toISOString() });
    }
  }
  if (!namespace) skipped.push({ kind: 'approvals', rel: '', reason: 'wy-ops.json에 approvals.namespace가 없어 승인 이력을 넣지 않음' });
  const plugins = readPlugins(home);
  const manifest = {
    schema: 1,
    tool: 'wy-ops transfer',
    createdAt: new Date().toISOString(),
    source: { home, project, projectKey: projectKey(project), namespace, secretsDir, user: path.basename(home), repo: repoInfo(project) },
    // 들여올 때 위치를 정하는 규칙. <home>·<project>는 들여오는 PC 값으로 바뀐다
    rules: {
      memory: '<home>/.claude/projects/<projectKey(project)>/memory/<rel>',
      approvals: '<home>/.claude/wy-approvals/<namespace>/<rel> (decisions마다 used 표시를 함께 씀)',
      handoff: '<home>/.claude/session-data/<rel>',
      transcripts: '<home>/.claude/projects/<projectKey(project)>/<rel>',
      settingsLocal: '<project>/.claude/<rel> (경로를 바꾸고 자리표시는 기존 값으로 채움)',
      claudeMd: '<home>/.claude/CLAUDE.md',
      skills: '<home>/.claude/skills/<rel>',
      agents: '<home>/.claude/agents/<rel>',
      hooks: '<home>/.claude/hooks/<rel>',
      globalSettings: '<home>/.claude/<rel> (경로를 바꾸고 자리표시는 기존 값으로 채움)',
      mcp: '<home>/.claude.json의 mcpServers·projects[<경로>].mcpServers에 서버별로 병합',
    },
    placeholder: PLACEHOLDER,
    redacted,
    plugins,
    files,
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') });
  const file = path.resolve(out || `wy-transfer-${path.basename(project)}-${stamp()}.zip`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zip(entries));
  return { file, files, skipped, redacted, plugins };
}

// ---- zip 읽기(lib/zip.js가 만든 것: deflate·stored, 32비트) ----
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip 파일이 아닙니다');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 목록이 깨졌습니다');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.slice(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error(`지원하지 않는 압축 방식: ${name}`);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

// 설정 JSON 안의 원래 home·project 경로를 새 값으로(\\ 이스케이프, / 모양 둘 다). 프로젝트를 먼저 바꾼다(홈 아래에 있을 수 있음)
function rewritePaths(text, from, to) {
  let t = text;
  for (const [a, b] of [
    [from.project, to.project],
    [from.home, to.home],
  ]) {
    if (!a || path.resolve(a) === path.resolve(b)) continue;
    const forms = (p) => [p.replace(/\//g, '\\').replace(/\\/g, '\\\\'), p.replace(/\\/g, '/')];
    const [aj, as] = forms(path.resolve(a));
    const [bj, bs] = forms(path.resolve(b));
    t = t.split(aj).join(bj).split(as).join(bs);
  }
  return t;
}

// 원래 경로 아래에서 벗어나는 rel(../ 등)은 받지 않는다
function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  if (!(p + path.sep).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep) || p.toLowerCase() === path.resolve(root).toLowerCase()) {
    throw new Error(`묶음 안 경로가 대상 폴더를 벗어납니다: ${rel}`);
  }
  return p;
}

const readJsonOr = (p, dflt) => {
  try {
    return readJsonFile(p);
  } catch {
    return dflt;
  }
};
const pretty = (o) => Buffer.from(JSON.stringify(o, null, 2) + '\n', 'utf8');

// ~/.claude.json에 mcpServers를 서버별로 병합한 새 내용과, 남은 자리표시
function mergeMcp(target, mcp) {
  const cur = readJsonOr(target, {});
  const next = JSON.parse(JSON.stringify(cur));
  const left = [];
  const put = (holder, servers, where) => {
    holder.mcpServers = holder.mcpServers || {};
    for (const [name, conf] of Object.entries(servers)) {
      const c = JSON.parse(JSON.stringify(conf));
      for (const k of restoreFrom(c, holder.mcpServers[name])) left.push({ where, key: [name, ...k].join('.') });
      holder.mcpServers[name] = c;
    }
  };
  put(next, mcp.user || {}, '~/.claude.json mcpServers');
  for (const [proj, servers] of Object.entries(mcp.projects || {})) {
    next.projects = next.projects || {};
    next.projects[proj] = next.projects[proj] || {};
    put(next.projects[proj], servers, `~/.claude.json projects["${proj}"].mcpServers`);
  }
  return { cur, next, left, exists: fs.existsSync(target) };
}

function importState({ project, zip: zipFile, home = os.homedir(), dryRun = false, include = {} }) {
  project = path.resolve(project);
  const items = unzip(fs.readFileSync(zipFile));
  const mbuf = items.get('manifest.json');
  if (!mbuf) throw new Error('manifest.json이 없습니다(wy-ops export로 만든 묶음이 아님)');
  const manifest = JSON.parse(mbuf.toString('utf8'));
  if (manifest.schema !== 1) throw new Error(`모르는 묶음 형식: schema ${manifest.schema}`);
  const ops = opsOf(project);
  const namespace = ops.namespace || manifest.source.namespace;
  const r = roots({ home, project, namespace });
  const wanted = new Set(kindsFor(include));
  const to = { home, project };
  const files = [];
  const skipped = [];
  const writes = [];
  const reenter = [];
  for (const f of manifest.files) {
    if (!wanted.has(f.kind)) {
      skipped.push({ kind: f.kind, rel: f.rel, reason: '옵션으로 끔' });
      continue;
    }
    if (!r[f.kind]) {
      skipped.push({ kind: f.kind, rel: f.rel, reason: '승인 namespace를 정할 수 없음' });
      continue;
    }
    let data = items.get(f.name);
    if (!data || sha256(data) !== f.sha256) throw new Error(`묶음이 손상되었습니다(해시 불일치): ${f.name}`);
    const target = safeJoin(r[f.kind], f.rel);
    let status;
    if (f.kind === 'mcp') {
      const m = mergeMcp(target, JSON.parse(rewritePaths(data.toString('utf8'), manifest.source, to)));
      reenter.push(...m.left.map((x) => ({ ...x, note: 'MCP 토큰·키·env 값' })));
      data = pretty(m.next);
      status = !m.exists ? 'new' : JSON.stringify(m.cur) === JSON.stringify(m.next) ? 'same' : 'overwrite';
    } else {
      if (JSON_KINDS.has(f.kind)) {
        const obj = JSON.parse(rewritePaths(data.toString('utf8'), manifest.source, to));
        const where = f.kind === 'settingsLocal' ? `<프로젝트>/.claude/${f.rel}` : `~/.claude/${f.rel}`;
        for (const k of restoreFrom(obj, readJsonOr(target, null))) reenter.push({ where, key: k.join('.'), note: '설정의 토큰·키·env 값' });
        data = pretty(obj);
      }
      status = !fs.existsSync(target) ? 'new' : sha256(fs.readFileSync(target)) === sha256(data) ? 'same' : 'overwrite';
    }
    files.push({ kind: f.kind, rel: f.rel, target, status });
    if (status !== 'same') writes.push({ f, target, data, status });
  }
  // 비밀값 폴더는 묶음에 없다(카드 1030). '비밀값 폴더 직접 복사' 같은 공통 할 일은 install.js가 출력하므로 reenter에는 구체 항목만 넣는다
  // 들여온 결정 중 used 표시가 없는 것(묶음에도 대상에도 없음) → used 표시를 쓴다
  const used = [];
  if (wanted.has('approvals') && r.approvals) {
    const inZip = new Set(manifest.files.filter((f) => f.kind === 'approvals').map((f) => f.rel));
    for (const f of manifest.files) {
      const m = f.kind === 'approvals' && f.rel.match(/^decisions\/([^/]+)\.json$/);
      if (!m || inZip.has(`used/${m[1]}.json`) || fs.existsSync(path.join(r.approvals, 'used', `${m[1]}.json`))) continue;
      used.push(m[1]);
    }
  }
  const backupDir = writes.some((w) => w.status === 'overwrite') ? path.join(home, '.claude', 'wy-transfer-backup', stamp()) : null;
  if (!dryRun) {
    for (const w of writes) {
      if (w.status === 'overwrite') {
        const b = path.join(backupDir, w.f.kind, w.f.rel);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(w.target, b);
      }
      fs.mkdirSync(path.dirname(w.target), { recursive: true });
      if (w.f.kind === 'mcp') {
        // ~/.claude.json은 Claude Code가 수시로 쓴다: 임시 파일에 쓴 뒤 이름을 바꿔 반쯤 쓴 파일이 보이지 않게 한다
        const tmp = `${w.target}.wy-transfer-${process.pid}`;
        fs.writeFileSync(tmp, w.data);
        fs.renameSync(tmp, w.target);
      } else {
        fs.writeFileSync(w.target, w.data);
        if (w.f.mtime) fs.utimesSync(w.target, new Date(), new Date(w.f.mtime));
      }
    }
    for (const id of used) {
      const p = path.join(r.approvals, 'used', `${id}.json`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ id, usedAt: new Date().toISOString(), imported: true }) + '\n');
    }
  }
  return { files, skipped, backupDir, markedUsed: used.length, reenter, plugins: manifest.plugins, source: manifest.source };
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
}

module.exports = { exportState, importState, projectKey, secretReason, redact, unzip, KINDS, PLACEHOLDER };
