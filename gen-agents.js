#!/usr/bin/env node
// 역할 파일 생성기(wy-ops 4단계): 템플릿 + 역할 원본 + 프로젝트 설정 → .claude/agents/<역할>.md
//   node tools/wy-ops/gen-agents.js [--check] [--root <저장소>] [--out <폴더>]
//   --check  쓰지 않고 지금 파일과 비교만 한다(줄바꿈·BOM은 무시). 다르면 처음 달라진 줄을 보여 주고 종료 코드 1
// 입력
//   <저장소>/.claude/wy-ops.json         roles(agent:false는 건너뜀), pmRole, commitRole, docs, memory …
//   <저장소>/.claude/ops/agent.md        프로젝트 템플릿(없으면 tools/wy-ops/templates/agent.md)
//   <저장소>/.claude/ops/roles/<역할>.md  역할 원본: frontmatter(description + 추가 줄) + '이 역할의 작업 방식' 본문
// 자리표시자: {{name}} {{description}} {{frontmatter}} {{body}} {{verifyList}}(verify·stackNotes에서 만든 목록)와 설정 경로({{pmRole}}, {{docs.progress}} …).
//   {{경로|size}}는 MB 값을 1024의 배수면 'nGB', 아니면 'nMB'로 쓴다. {{경로|indent}}는 줄마다 두 칸 들여 써서 앞 글머리의 하위 목록으로 만든다.
//   모르는 자리표시자는 오류로 멈춘다.
const fs = require('fs');
const path = require('path');
const { loadOpsConfig, findProjectRoot } = require('./vscode/opsConfig');

const DEFAULT_TEMPLATE = path.join(__dirname, 'templates', 'agent.md');

function args(argv) {
  const out = { check: false, root: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') out.check = true;
    else if (argv[i] === '--root') out.root = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else throw new Error(`알 수 없는 인자: ${argv[i]}`);
  }
  return out;
}

const read = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

// 역할 원본: --- description: …, 추가 줄 … --- 본문
function readRole(file) {
  const m = read(file).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: frontmatter(---)가 없습니다`);
  const lines = m[1].split('\n');
  const desc = lines.find((l) => l.startsWith('description: '));
  if (!desc) throw new Error(`${file}: description이 없습니다`);
  return {
    description: desc.slice('description: '.length),
    frontmatter: lines.filter((l) => l !== desc).map((l) => l + '\n').join(''),
    body: m[2].replace(/\s+$/, ''),
  };
}

// 검증 명령(wy-ops.json verify: setup·build·test·typecheck·lint·format, 해당 없으면 null)과 스택 메모(stackNotes) → 목록 줄
//   값은 명령 문자열, 또는 폴더마다 다르면 { 폴더: 명령 }('.'은 루트, lib/detect.js)
const VERIFY_KEYS = [['setup', '준비(처음 한 번·의존성 바뀔 때)'], ['build', '빌드'], ['test', '테스트'], ['typecheck', '타입 검사'], ['lint', '린트'], ['format', '형식 검사']];
const dirLabel = (d) => (d === '.' ? '루트' : `${String(d).replace(/[\\/]+$/, '')}/`);
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function verifyValue(v, code = (s) => `\`${s}\``) {
  if (typeof v === 'string') return v.trim() ? code(v.trim()) : null;
  if (!isMap(v)) return null;
  const parts = Object.entries(v).filter(([, c]) => typeof c === 'string' && c.trim()).map(([d, c]) => `${code(c.trim())} (${dirLabel(d)})`);
  return parts.length ? parts.join(' · ') : null;
}
// 스택 이름(doctor·install 출력): 알아낸 폴더가 있으면 'java-gradle(backend/), node(frontend/)', 없으면 stack 문자열
function stackLabel(ops) {
  const d = Array.isArray(ops && ops.detected) ? ops.detected : [];
  if (d.length) return d.map((x) => (x.dir === '.' ? x.stack : `${x.stack}(${dirLabel(x.dir)})`)).join(', ');
  return (ops && ops.stack) || '';
}
function verifyList(ops) {
  const v = (ops && ops.verify) || {};
  const lines = VERIFY_KEYS.map(([k, label]) => [label, verifyValue(v[k])]).filter(([, s]) => s).map(([label, s]) => `- ${label}: ${s}`);
  if (lines.length && VERIFY_KEYS.some(([k]) => isMap(v[k]))) lines.unshift('- 폴더가 붙은 명령은 그 폴더에서 돌리고, 바뀐 폴더의 것만 돌린다.');
  if (!lines.length) lines.push('- (아직 정하지 않았다. `.claude/wy-ops.json`의 `verify`에 setup·build·test·typecheck·lint·format 명령을 적는다)');
  for (const n of Array.isArray(ops && ops.stackNotes) ? ops.stackNotes : []) if (typeof n === 'string' && n.trim()) lines.push(`- ${n.trim()}`);
  return lines.join('\n');
}

// 머리글(frontmatter)의 name·description 값: 그대로 두면 YAML이 다르게 읽는 값(': '·' #'·앞의 지시 문자·true/null/숫자 등)만
// 큰따옴표로 감싼다(JSON 문자열은 YAML 큰따옴표 문자열로도 맞다). 안전한 값은 그대로 두어 생성물이 괜히 바뀌지 않게 한다.
function yamlScalar(v) {
  const s = String(v);
  if (/^"(?:[^"\\]|\\.)*"$|^'(?:[^']|'')*'$/.test(s)) return s; // 원본에서 이미 따옴표로 감싼 값은 그대로(두 번 감싸면 따옴표가 값에 들어간다)
  const plain = s !== '' && s === s.trim() && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/: |:$| #|[\x00-\x1f]/.test(s)
    && !/^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan)$/i.test(s);
  return plain ? s : JSON.stringify(s);
}

// 채운 결과의 첫 머리글 블록에서 name:·description: 줄 값만 yamlScalar로 바꾼다(본문의 {{description}}은 그대로)
function quoteFrontmatter(text) {
  return text.replace(/^---\n([\s\S]*?\n)---\n/, (all, head) =>
    '---\n' + head.replace(/^(name|description): (.*)$/gm, (l, k, v) => `${k}: ${yamlScalar(v)}`) + '---\n');
}

// '## 스킬 쓰는 때' 절(templates/skills.json, SKL D-23): 역할의 template → group → 이름에서 접두사·끝 숫자를 뗀 것 순으로 키를 찾는다.
// 템플릿의 {{skillNotes}}는 다음 절 제목 바로 앞에 붙어 있으므로, 절이 있으면 끝에 빈 줄까지 넣고 없으면 빈 문자열
const SKILLS = path.join(__dirname, 'templates', 'skills.json');
// 역할이 맞춰 볼 키 후보(앞이 우선). init의 화면 역할 판정(contextStandard)도 같은 후보를 쓴다
function roleKeys(role) {
  const short = String(role.name || '').replace(/^[A-Za-z0-9]+-/, '').replace(/\d+$/, '');
  return [role.template, role.group, short].filter(Boolean);
}
function roleEntry(map, role) {
  const key = roleKeys(role).find((k) => Object.prototype.hasOwnProperty.call(map, k));
  return key ? map[key] : [];
}
function skillNotes(role) {
  const lines = roleEntry(fs.existsSync(SKILLS) ? JSON.parse(read(SKILLS)).notes || {} : {}, role);
  return lines.length ? `## 스킬 쓰는 때\n${lines.map((l) => `- ${l}`).join('\n')}\n\n` : '';
}

// 역할 세션에서 안 쓰는 내장 도구(templates/context.json, TOK-4 D-22) → frontmatter 'disallowedTools: A, B' 줄.
// keepTools에 맞는 역할은 그 도구를 남긴다. 역할 원본에 disallowedTools 줄이 있으면 그것을 쓴다(빈 값이면 줄 없음)
const CONTEXT = path.join(__dirname, 'templates', 'context.json');
let context; // 역할마다 다시 읽지 않도록 한 번만 읽는다
function toolsFrontmatter(role, frontmatter) {
  if (/^disallowedTools:/m.test(frontmatter)) return frontmatter.replace(/^disallowedTools:[ \t]*(\[[ \t]*\]|""|'')?[ \t]*\r?\n/m, '');
  const c = context || (context = fs.existsSync(CONTEXT) ? JSON.parse(read(CONTEXT)) : {});
  const keep = roleEntry(c.keepTools || {}, role);
  const list = (c.disallowedTools || []).filter((t) => !keep.includes(t));
  return list.length ? `${frontmatter}disallowedTools: ${list.join(', ')}\n` : frontmatter;
}

const size = (mb) => (Number(mb) % 1024 === 0 ? `${Number(mb) / 1024}GB` : `${Number(mb)}MB`);

function fill(template, values, where) {
  return template.replace(/\{\{([\w.]+)(?:\|(size|indent))?\}\}/g, (all, key, filter) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), values);
    if (v === undefined || v === null || typeof v === 'object') throw new Error(`${where}: 자리표시자 ${all}의 값이 없습니다`);
    if (filter === 'size') return size(v);
    if (filter === 'indent') return String(v).replace(/^(?=.)/gm, '  ');
    return String(v);
  });
}

function generate(root) {
  const ops = loadOpsConfig(root);
  if (!ops) throw new Error(`${root}/.claude/wy-ops.json을 읽지 못했습니다`);
  const projectTemplate = path.join(root, '.claude', 'ops', 'agent.md');
  const templateFile = fs.existsSync(projectTemplate) ? projectTemplate : DEFAULT_TEMPLATE;
  const template = read(templateFile);
  const roles = (ops.roles || []).filter((r) => r && r.name && r.agent !== false);
  if (!roles.length) throw new Error('wy-ops.json에 역할 파일을 만들 역할(agent가 false가 아닌 roles)이 없습니다');
  return roles.map((r) => {
    const roleFile = path.join(root, '.claude', 'ops', 'roles', `${r.name}.md`);
    if (!fs.existsSync(roleFile)) throw new Error(`역할 원본이 없습니다: ${roleFile}`);
    const role = readRole(roleFile);
    role.frontmatter = toolsFrontmatter(r, role.frontmatter);
    return { name: r.name, text: quoteFrontmatter(fill(template, { ...ops, verifyList: verifyList(ops), skillNotes: skillNotes(r), ...role, name: r.name }, templateFile)) };
  });
}

function firstDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return { line: i + 1, want: x[i], got: y[i] };
  return null;
}

function main() {
  const opt = args(process.argv.slice(2));
  const root = path.resolve(opt.root || findProjectRoot(process.cwd()) || '');
  if (!fs.existsSync(path.join(root, '.claude', 'wy-ops.json'))) throw new Error('프로젝트 설정(.claude/wy-ops.json)을 찾지 못했습니다. --root로 저장소를 지정하세요');
  const outDir = path.resolve(opt.out || path.join(root, '.claude', 'agents'));
  let differ = 0;
  const written = [];
  for (const { name, text } of generate(root)) {
    const file = path.join(outDir, `${name}.md`);
    if (opt.check) {
      // core.autocrlf=true인 체크아웃은 CRLF로 풀리므로, 읽을 때처럼 BOM·줄 끝을 정규화해 비교한다
      const cur = fs.existsSync(file) ? read(file) : null;
      if (cur === text) console.log(`같음  ${name}`);
      else {
        differ++;
        const d = cur === null ? null : firstDiff(text, cur);
        console.log(cur === null ? `없음  ${name}` : `다름  ${name} (${d.line}행)\n  생성: ${d.want}\n  지금: ${d.got}`);
      }
    } else {
      // 이미 있는 파일은 그 줄바꿈(CRLF/LF)을 따라 줄바꿈만 바뀐 diff가 생기지 않게 한다. 새 파일은 LF, BOM 없음
      const crlf = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('\r\n');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
      console.log(`썼음  ${file}${crlf ? ' (CRLF)' : ''}`);
      written.push(file);
    }
  }
  // 기본 위치(.claude/agents)에 썼으면 lock의 그 항목도 맞춘다(--out으로 다른 곳에 쓴 것은 생성물이 아님)
  if (!opt.check && !opt.out && written.length) require('./lib/lock').recordWritten(root, written);
  if (opt.check) {
    console.log(differ ? `다른 파일 ${differ}개` : '모두 같음');
    process.exit(differ ? 1 : 0);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('gen-agents: ' + err.message);
    process.exit(2);
  }
}

module.exports = { generate, readRole, fill, size, verifyList, verifyValue, stackLabel, isMap, dirLabel, skillNotes, toolsFrontmatter, roleKeys, yamlScalar, quoteFrontmatter, VERIFY_KEYS };
