// 프로젝트 폴더를 보고 스택과 검증 명령을 알아낸다(STK). init·install.js detect·설치 마법사가 쓴다
//   detect(폴더) → { detected: [{ dir, stack }], verify: { 키: 문자열 | { 폴더: 명령 } | null }, tools, stackNotes }
//   표지 파일·우선순위: templates/stacks/<id>.json의 markers('*.sln'처럼 '*'로 시작하면 끝이 같은 파일)·order. 폴더당 하나
//   범위: 루트 + 1단계 하위 폴더(점으로 시작하는 폴더·EXCLUDE 제외). 루트가 집계 빌드 스택(템플릿 "aggregate": true — gradle·maven·sln·CMake)이면
//         같은 스택으로 잡힌 하위 폴더는 루트 빌드의 모듈로 보고 뺀다. node·python 하위 폴더는 남긴다(루트 package.json이 도구 전용일 수 있음)
//   다듬기(REFINE): 폴더의 파일 내용으로 템플릿 값을 고친다. 모르면 null(추측해서 채우지 않음)
//   verify 값: 알아낸 폴더가 루트 하나면 문자열(지금 형식), 하위 폴더가 있으면 { 폴더: 명령 }('.'은 루트)
//   forProject(폴더): 설정에 verify가 이미 있으면 그것(existing: true), 없으면 detect 결과. describe(결과): 사람이 읽는 줄
//   applyTo(폴더): 다시 판정해 wy-ops.json에 쓴다(install.ps1 detect --apply). verify는 빈 키만 채운다
const fs = require('fs');
const path = require('path');
const { VERIFY_KEYS, verifyValue, stackLabel, dirLabel } = require('../gen-agents');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const EXCLUDE = new Set(['node_modules', 'build', 'dist', 'out', 'bin', 'obj', 'target', 'vendor', 'docs']);

const entries = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const has = (dir, f) => fs.existsSync(path.join(dir, f));
const text = (dir, f) => {
  try {
    return fs.readFileSync(path.join(dir, f), 'utf8');
  } catch {
    return '';
  }
};

// init.loadStack과 같은 경로(fillText)로 읽는다. init이 이 모듈을 불러오므로 여기서는 쓸 때 불러온다
function loadStacks(templatesDir = TEMPLATES, vars = {}) {
  const { listStacks, loadStack } = require('./init');
  return listStacks(templatesDir).map((s) => loadStack(templatesDir, s.id, vars))
    .filter((s) => Array.isArray(s.markers) && s.markers.length)
    .sort((a, b) => a.order - b.order);
}

function stackOf(dir, stacks) {
  const names = entries(dir).filter((e) => !e.isDirectory()).map((e) => e.name.toLowerCase());
  const hit = (m) => (m.startsWith('*') ? names.some((n) => n.endsWith(m.slice(1).toLowerCase())) : names.includes(m.toLowerCase()));
  return stacks.find((s) => s.markers.some(hit)) || null;
}

// 래퍼 스크립트(gradlew·mvnw)가 없으면 설치한 명령으로(검증 명령·메모 둘 다)
const wrapper = (file, cmd) => (st, dir) => {
  if (has(dir, file)) return {};
  const swap = (v) => (typeof v === 'string' ? v.replace(new RegExp(`\\./${file}\\b`, 'g'), cmd) : v);
  return { verify: Object.fromEntries(Object.entries(st.verify).map(([k, v]) => [k, swap(v)])), notes: (st.notes || []).map(swap) };
};

const REFINE = {
  // package.json scripts에 있는 것만. 실행기는 잠금 파일로. 'format'은 보통 고쳐 쓰는 명령이라 format:check만 쓴다
  node(st, dir) {
    let scripts = {};
    try {
      scripts = JSON.parse(text(dir, 'package.json').replace(/^﻿/, '')).scripts || {};
    } catch {
      scripts = {};
    }
    const pm = has(dir, 'pnpm-lock.yaml') ? 'pnpm' : has(dir, 'yarn.lock') ? 'yarn' : has(dir, 'bun.lockb') || has(dir, 'bun.lock') ? 'bun' : 'npm';
    const pick = (...names) => names.find((n) => typeof scripts[n] === 'string' && scripts[n].trim() && !(n === 'test' && /no test specified/.test(scripts[n])));
    // 'bun test'는 bun 자체 시험 실행기라 스크립트는 'bun run test'로
    const run = (n) => (!n ? null : n === 'test' && pm !== 'bun' ? `${pm} test` : pm === 'yarn' ? `yarn ${n}` : `${pm} run ${n}`);
    // Yarn Berry(.yarnrc.yml)는 --frozen-lockfile 대신 --immutable
    const setup = pm === 'npm' ? (has(dir, 'package-lock.json') ? 'npm ci' : 'npm install') : pm === 'yarn' && has(dir, '.yarnrc.yml') ? 'yarn install --immutable' : `${pm} install --frozen-lockfile`;
    const tools = pm === 'npm' ? st.tools : st.tools.filter((t) => t.cmd !== 'npm').concat([{ cmd: pm, label: pm, install: `npm install -g ${pm} (또는 corepack enable)` }]);
    return { tools, verify: { setup, build: run(pick('build')), test: run(pick('test')), typecheck: run(pick('typecheck', 'type-check')), lint: run(pick('lint')), format: run(pick('format:check', 'check-format')) } };
  },
  'java-gradle': wrapper('gradlew', 'gradle'),
  'java-maven': wrapper('mvnw', 'mvn'),
  // 설정이 있는 도구만: requirements.txt → setup, pytest·mypy·ruff 설정 → test·typecheck·lint·format
  python(st, dir) {
    const py = text(dir, 'pyproject.toml');
    const cfg = text(dir, 'setup.cfg');
    const on = (yes, k) => (yes ? st.verify[k] : null);
    const pytest = has(dir, 'pytest.ini') || has(dir, 'conftest.py') || has(dir, 'tests') || /\[tool\.pytest/.test(py) || /\[tool:pytest\]/.test(cfg);
    const mypy = has(dir, 'mypy.ini') || has(dir, '.mypy.ini') || /\[tool\.mypy\]/.test(py) || /\[mypy\]/.test(cfg);
    const ruff = has(dir, 'ruff.toml') || has(dir, '.ruff.toml') || /\[tool\.ruff/.test(py);
    return { verify: { setup: on(has(dir, 'requirements.txt'), 'setup'), test: on(pytest, 'test'), typecheck: on(mypy, 'typecheck'), lint: on(ruff, 'lint'), format: on(ruff, 'format') } };
  },
};

const toolKey = (t) => JSON.stringify(Array.isArray(t.anyOf) ? [...t.anyOf].sort() : [t.cmd]);

function detect(project, templatesDir = TEMPLATES, vars = {}) {
  const stacks = loadStacks(templatesDir, vars);
  const found = [];
  const root = stackOf(project, stacks);
  if (root) found.push({ dir: '.', st: root });
  const subs = entries(project).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !EXCLUDE.has(e.name.toLowerCase())).map((e) => e.name).sort();
  for (const name of subs) {
    const st = stackOf(path.join(project, name), stacks);
    if (st && !(root && root.aggregate && st.id === root.id)) found.push({ dir: name, st });
  }
  const parts = found.map(({ dir, st }) => {
    const r = REFINE[st.id] ? REFINE[st.id](st, path.join(project, dir)) : {};
    return { dir, stack: st.id, verify: { ...st.verify, ...(r.verify || {}) }, tools: r.tools || st.tools || [], notes: r.notes || st.notes || [] };
  });
  const rootOnly = parts.length === 1 && parts[0].dir === '.';
  const verify = {};
  for (const [k] of VERIFY_KEYS) {
    const m = {};
    for (const p of parts) if (typeof p.verify[k] === 'string' && p.verify[k].trim()) m[p.dir] = p.verify[k].trim();
    verify[k] = !Object.keys(m).length ? null : rootOnly ? m['.'] : m;
  }
  const tools = [];
  for (const p of parts) for (const t of p.tools) if (!tools.some((x) => toolKey(x) === toolKey(t))) tools.push(t);
  const stackNotes = [];
  for (const p of parts) {
    for (const n of p.notes) {
      const s = rootOnly ? n : `(${dirLabel(p.dir)}) ${n}`;
      if (!stackNotes.includes(s)) stackNotes.push(s);
    }
  }
  return { detected: parts.map(({ dir, stack }) => ({ dir, stack })), verify, tools, stackNotes };
}

const opsFile = (project) => path.join(project, '.claude', 'wy-ops.json');
const readOps = (project) => JSON.parse(fs.readFileSync(opsFile(project), 'utf8').replace(/^﻿/, ''));

function forProject(project, templatesDir = TEMPLATES) {
  let ops = null;
  try {
    ops = readOps(project);
  } catch {
    ops = null;
  }
  if (ops && ops.verify !== undefined) return { existing: true, detected: Array.isArray(ops.detected) ? ops.detected : ops.stack ? [{ dir: '.', stack: ops.stack }] : [], verify: ops.verify || {} };
  return { existing: false, ...detect(project, templatesDir) };
}

// 폴더를 다시 판정해 wy-ops.json에 쓴다(install.ps1 detect --apply, 빈 폴더에 설치한 뒤 코드가 생겼을 때)
//   verify는 이미 값이 있는 키를 그대로 두고 비어 있는(null·빈 값) 키만 판정 값으로 채운다(손으로 적은 명령 보존, pm 결정 2026-10-18).
//   있는 값과 판정 값이 다르면 덮지 않고 diffs로 돌려준다. detected·tools·stackNotes는 판정으로 바꾸고 옛 stack 키는 지운다(detected와 어긋나지 않게).
//   다른 키는 그대로, .bak-<시각>(init 'filled'와 같은 settings.apply)
//   → { missing: true } 설정 없음 | { changed: false } 알아낸 것이 없음 | { changed: false, same: true, diffs } 이미 같음(둘 다 파일 그대로)
//     | { changed: true, before(바꾸기 전 verify), ops(쓴 설정), bak, diffs }   diffs: [{ key, before, detected }]
function applyTo(project, templatesDir = TEMPLATES, now = new Date()) {
  if (!fs.existsSync(opsFile(project))) return { missing: true };
  const ops = readOps(project);
  const vars = { project: ops.project, prefix: ops.rolePrefix };
  const d = detect(project, templatesDir, vars);
  if (!d.detected.length) return { changed: false };
  // 설정의 스택 부분은 init과 같은 함수로(키 목록을 한 곳에서)
  const part = require('./init').stackPart(templatesDir, project, null, {}, vars, d);
  const old = ops.verify && typeof ops.verify === 'object' ? ops.verify : {};
  const isSet = (v) => verifyValue(v, (s) => s) != null;
  const diffs = [];
  for (const [k] of VERIFY_KEYS) {
    if (!isSet(old[k])) continue;
    if (isSet(part.verify[k]) && JSON.stringify(old[k]) !== JSON.stringify(part.verify[k])) diffs.push({ key: k, before: old[k], detected: part.verify[k] });
    part.verify[k] = old[k];
  }
  for (const k of Object.keys(old)) if (!(k in part.verify)) part.verify[k] = old[k];
  if (ops.stack === undefined && Object.keys(part).every((k) => JSON.stringify(ops[k]) === JSON.stringify(part[k]))) return { changed: false, same: true, diffs };
  const before = ops.verify;
  delete ops.stack;
  Object.assign(ops, part);
  const bak = require('./settings').apply(opsFile(project), ops, now);
  return { changed: true, before, ops, bak, diffs };
}

// 검증 명령 줄('빌드: …'). 없으면 빈 배열
const verifyLines = (verify) => VERIFY_KEYS.map(([k, label]) => [label, verifyValue((verify || {})[k], (s) => s)]).filter(([, s]) => s).map(([label, s]) => `${label}: ${s}`);

function describe(r) {
  const lines = [r.existing ? '있는 설정(.claude/wy-ops.json)의 검증 명령입니다.' : '폴더의 파일로 알아낸 검증 명령입니다.'];
  lines.push(`알아낸 폴더: ${r.detected.length ? stackLabel(r) : '없음'}`);
  const cmds = verifyLines(r.verify);
  lines.push(...cmds);
  if (!cmds.length) lines.push('검증 명령을 찾지 못했습니다. 코드가 생긴 뒤 install.ps1 detect --apply로 채우고 install.ps1 gen을 돌리세요.');
  return lines;
}

module.exports = { detect, forProject, describe, applyTo, verifyLines };
