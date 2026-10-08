// 새 프로젝트에 운영 도구 파일을 만든다(OPS-10-2). install.js init이 부르고, settings 병합·승인 폴더·doctor는 install.js가 이어서 한다.
//   init({ project, name, prefix, stack, verify, roles, counts, areas, principles, templatesDir }) → { files: [{ file, action }], claudeMd, ops }
//   역할: templates/roles.json의 기본 구성(groups). roles: 넣을 그룹 id 목록(commit·pm은 늘 넣음), counts: { 그룹 id: 세션 수 }(multi 그룹만 2 이상),
//         areas: { 역할 이름: 담당 영역(디렉터리) }. 2개 이상이면 이름 끝에 번호(<접두사>backend1, <접두사>backend2), 1번이 공용 파일 담당
//   stack: templates/stacks/<id>.json(개발 도구·검증 명령·메모). verify: { setup|build|test|typecheck|lint|format: 명령 } 스택 값 덮어쓰기
//   principles: CLAUDE.md 절에 '작업 원칙'(templates/principles.md)을 넣을지(기본 넣음)
//   만드는 것: .claude/wy-ops.json, .claude/ops/roles/<prefix><짧은 이름>.md, .claude/ops/pm-ops.project.md,
//              .claude/agents/*.md·.claude/skills/pm-ops/(gen-agents·gen-skill), .gitignore 줄, .claude/wy-ops.lock.json
//   이미 있는 파일은 덮지 않는다(lock에 없는 기존 파일 = unmanaged → 건너뜀). CLAUDE.md는 고치지 않고 넣을 절만 돌려준다.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lock = require('./lock');
const { fill, verifyList, VERIFY_KEYS } = require('../gen-agents');

const PKG = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(f, 'utf8');

function fillText(text, vars) {
  return text.replace(/\{\{(project|prefix|rolesTable)\}\}/g, (m, k) => (vars[k] == null ? m : vars[k]));
}

// 역할 구성 펼치기: 그룹 × 세션 수 → roles 항목 { name, summary, agent, template, group, area?, lead? }
function expandRoles(catalog, { prefix, only = null, counts = {}, areas = {} }) {
  const max = catalog.maxPerRole || 4;
  const ids = new Set(catalog.groups.map((g) => g.id));
  for (const k of [...(only || []), ...Object.keys(counts)]) if (!ids.has(k)) throw new Error(`모르는 역할: ${k} (고를 수 있는 것: ${[...ids].join(', ')})`);
  const out = [];
  for (const g of catalog.groups) {
    if (only && !g.fixed && !only.includes(g.id)) continue;
    const n = counts[g.id] == null ? g.count : Number(counts[g.id]);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${g.id} 세션 수는 0~${max}: ${counts[g.id]}`);
    if (g.fixed && n !== 1) throw new Error(`${g.id}는 꼭 1개입니다`);
    if (!g.multi && n > 1) throw new Error(`${g.id}는 여러 개로 나눌 수 없습니다(나눌 수 있는 것: ${catalog.groups.filter((x) => x.multi).map((x) => x.id).join(', ')})`);
    for (let i = 1; i <= n; i++) {
      const name = `${prefix}${g.id}${n > 1 ? i : ''}`;
      const r = { name, summary: g.summary, agent: g.agent !== false, group: g.id };
      if (g.template) r.template = g.template;
      if (n > 1) {
        r.area = areas[name] && String(areas[name]).trim() ? String(areas[name]).trim() : null;
        r.lead = i === 1;
        r.summary = `${g.summary} — ${r.area ? `담당 \`${r.area}\`` : '담당 영역은 pm이 배정'}${r.lead ? ', 같은 역할의 공용 파일 담당' : ''}`;
      }
      out.push(r);
    }
  }
  for (const k of Object.keys(areas)) if (!out.some((r) => r.name === k && 'area' in r)) throw new Error(`담당 영역은 여러 개로 나눈 역할에만 줍니다: ${k}`);
  return out;
}

// 같은 역할을 여러 세션으로 나눴을 때의 규칙(CLAUDE.md 절)
function parallelRules(ops) {
  const groups = {};
  for (const r of ops.roles) if ('area' in r) (groups[r.group] = groups[r.group] || []).push(r);
  const lines = Object.values(groups).map((rs) => {
    const lead = rs.find((r) => r.lead) || rs[0];
    return `- ${rs.map((r) => `\`${r.name}\``).join('·')}는 같은 역할을 담당 영역으로 나눠 병렬로 일한다. 담당 영역 밖은 수정하지 않는다. 영역 밖이거나 여러 세션이 함께 쓰는 공용 파일은 \`${lead.name}\`에 요청한다. 영역이 정해지지 않았으면 \`${ops.pmRole}\`이 작업을 배정할 때 정한다.`;
  });
  return lines.length ? lines.join('\n') : '- 같은 역할을 여러 세션으로 나누지 않았다.';
}

// 여러 개로 나눈 역할의 원본 끝에 붙이는 담당 영역 절
function areaSection(r, ops) {
  const peers = ops.roles.filter((x) => x.group === r.group && x.name !== r.name);
  const lead = ops.roles.find((x) => x.group === r.group && x.lead);
  return [
    '',
    '## 담당 영역',
    `- 이 세션의 담당: ${r.area ? `\`${r.area}\`` : `아직 정하지 않음(\`${ops.pmRole}\`이 배정)`}. 영역 밖은 수정하지 않는다.`,
    `- 같은 역할의 다른 세션: ${peers.map((x) => `\`${x.name}\`${x.area ? `(\`${x.area}\`)` : ''}`).join(', ')}.`,
    r.lead
      ? '- 영역 밖이거나 여러 세션이 함께 쓰는 공용 파일은 이 세션이 맡는다. 다른 세션의 요청을 받아 고치고 결과를 알린다.'
      : `- 영역 밖이거나 여러 세션이 함께 쓰는 공용 파일은 직접 고치지 말고 \`${lead.name}\`에 요청한다.`,
    '',
  ].join('\n');
}

function rolesTable(ops) {
  const rows = ops.roles.map((r) => `| \`${r.name}\` | ${r.summary || ''} |`);
  return ['| 이름 | 역할 |', '|---|---|', ...rows].join('\n');
}

// 스택 목록(templates/stacks/*.json): [{ id, label }]
function listStacks(templatesDir = path.join(PKG, 'templates')) {
  const dir = path.join(templatesDir, 'stacks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const s = JSON.parse(read(path.join(dir, f)));
    return { id: s.id, label: s.label };
  });
}

function loadStack(templatesDir, id, vars) {
  const file = path.join(templatesDir, 'stacks', `${id}.json`);
  if (!/^[a-z0-9-]+$/.test(id || '') || !fs.existsSync(file)) {
    throw new Error(`스택이 없습니다: ${id} (고를 수 있는 것: ${listStacks(templatesDir).map((s) => s.id).join(', ')})`);
  }
  return JSON.parse(fillText(read(file), vars));
}

function init({ project, name, prefix, stack = null, verify = {}, roles = null, counts = {}, areas = {}, principles = true, extrasOff = null, templatesDir = path.join(PKG, 'templates'), version = null }) {
  if (!project) throw new Error('project가 없습니다');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name || '')) throw new Error(`프로젝트 이름은 영문·숫자·._-로: ${name}`);
  if (!/^[A-Za-z0-9]{1,8}-$/.test(prefix || '')) throw new Error(`역할 접두사는 영문·숫자 1~8자 + '-'(예: AB-): ${prefix}`);
  const vars = { project: name, prefix };
  fs.mkdirSync(project, { recursive: true });
  const cfgFile = path.join(project, '.claude', 'wy-ops.json');
  const l = lock.readLock(project);
  const planned = [];
  const plan = (file, content) => planned.push({ ...lock.decide(project, l, file, content), content });

  // 1. 설정: 이미 있으면 그것을 쓴다(덮지 않음)
  let ops;
  if (fs.existsSync(cfgFile)) {
    ops = JSON.parse(read(cfgFile).replace(/^﻿/, ''));
    planned.push({ file: '.claude/wy-ops.json', action: 'unmanaged', content: null });
  } else {
    ops = JSON.parse(fillText(read(path.join(templatesDir, 'wy-ops.json')), vars));
    // 이 프로젝트가 쓰는 패키지 버전(doctor가 설치본과 비교). 바꿀 때는 사용자가 고친다
    ops.wyOpsVersion = version || JSON.parse(read(path.join(PKG, 'package.json'))).version;
    if (extrasOff) ops.extras = { off: extrasOff };
    ops.roles = expandRoles(JSON.parse(read(path.join(templatesDir, 'roles.json'))), { prefix, only: roles && roles.length ? roles : null, counts, areas });
    if (stack) {
      const st = loadStack(templatesDir, stack, vars);
      ops.stack = st.id;
      ops.verify = {};
      for (const [k] of VERIFY_KEYS) ops.verify[k] = verify[k] != null && String(verify[k]).trim() ? String(verify[k]).trim() : st.verify[k] == null ? null : st.verify[k];
      ops.stackNotes = st.notes || [];
      ops.tools = Array.isArray(st.tools) ? st.tools : [];
    }
    plan('.claude/wy-ops.json', JSON.stringify(ops, null, 2) + '\n');
  }

  // 2. 역할 원본(agent:true만): templates/roles/<짧은 이름>.md
  for (const r of ops.roles.filter((x) => x.agent)) {
    const short = r.template || (r.name.startsWith(prefix) ? r.name.slice(prefix.length) : r.name);
    const src = path.join(templatesDir, 'roles', `${short}.md`);
    if (!fs.existsSync(src)) throw new Error(`역할 템플릿이 없습니다: roles/${short}.md`);
    let text = fillText(read(src), vars);
    if ('area' in r) {
      text = text.replace(/^(---\r?\ndescription: .*?)(\r?\n)/, (m, d, nl) => `${d} 담당: ${r.area || 'pm이 배정'}.${nl}`).replace(/\s*$/, '\n') + areaSection(r, ops);
    }
    plan(`.claude/ops/roles/${r.name}.md`, text);
  }
  plan('.claude/ops/pm-ops.project.md', fillText(read(path.join(templatesDir, 'pm-ops.project.md')), vars));
  // CLAUDE.md에 넣을 절: 설정(역할 표·pm·커밋 역할·메모리 기준·검증 명령)에서 만든다. CLAUDE.md 자체는 고치지 않고 참고 파일로 남긴다
  const principlesText = principles && fs.existsSync(path.join(templatesDir, 'principles.md')) ? read(path.join(templatesDir, 'principles.md')).trim() : '';
  const claudeMd = fill(read(path.join(templatesDir, 'claude-md.md')), { ...ops, ...vars, rolesTable: rolesTable(ops), verifyList: verifyList(ops), parallelRules: parallelRules(ops), principles: principlesText }, 'claude-md.md')
    .replace(/\n{3,}/g, '\n\n');
  plan('.claude/ops/CLAUDE.part.md', claudeMd.trim() + '\n');

  // 3. .gitignore: 빠진 줄만 덧붙인다(사람이 관리하는 파일이라 lock에 넣지 않음)
  const gi = path.join(project, '.gitignore');
  const have = fs.existsSync(gi) ? read(gi) : '';
  const want = read(path.join(templatesDir, 'gitignore.txt')).split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const missing = want.filter((w) => !have.split(/\r?\n/).map((s) => s.trim()).includes(w));
  if (missing.length) fs.writeFileSync(gi, `${have}${have && !have.endsWith('\n') ? '\n' : ''}\n# WY Ops\n${missing.join('\n')}\n`);

  let next = lock.writePlanned(project, l, planned.filter((p) => p.content != null), version);

  // 4. 생성: gen-agents·gen-skill(사람이 고친 생성 파일이 있으면 생성기를 돌리지 않는다 — update가 차이만 보여 줌)
  const gen = (script) => execFileSync(process.execPath, [path.join(PKG, script), '--root', project], { encoding: 'utf8' });
  gen('gen-agents.js');
  gen('gen-skill.js');
  const generated = [];
  for (const f of listGenerated(project)) generated.push({ ...lock.decide(project, next, f, read(path.join(project, f))), content: read(path.join(project, f)) });
  next = lock.writePlanned(project, next, generated, version);

  return {
    files: [...planned, ...generated].map(({ file, action }) => ({ file, action })),
    gitignoreAdded: missing,
    claudeMd,
    ops,
  };
}

// 생성 파일 목록(프로젝트 기준 상대 경로)
function listGenerated(project) {
  const out = [];
  const agents = path.join(project, '.claude', 'agents');
  if (fs.existsSync(agents)) for (const f of fs.readdirSync(agents).filter((x) => x.endsWith('.md')).sort()) out.push(`.claude/agents/${f}`);
  for (const f of ['.claude/skills/pm-ops/SKILL.md', '.claude/skills/pm-ops/scripts/session.ps1']) if (fs.existsSync(path.join(project, f))) out.push(f);
  return out;
}

module.exports = { init, listGenerated, rolesTable, fillText, listStacks, loadStack, expandRoles, parallelRules };
