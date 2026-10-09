// gen-agents.js 줄바꿈 처리 검사: node tools/wy-ops/gen-agents.test.js (통과하면 종료 코드 0)
// core.autocrlf=true 체크아웃처럼 지금 파일이 CRLF여도 --check는 같다고 보고, 쓸 때는 그 줄바꿈을 따른다.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GEN = path.join(__dirname, 'gen-agents.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-agents-'));
const w = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const run = (...args) => spawnSync(process.execPath, [GEN, '--root', root, ...args], { encoding: 'utf8' });

try {
  w('.claude/wy-ops.json', JSON.stringify({ pmRole: 'XX-pm', roles: [{ name: 'XX-a' }, { name: 'XX-b' }, { name: 'XX-c' }, { name: 'XX-pm', agent: false }] }));
  w('.claude/ops/agent.md', '---\nname: {{name}}\ndescription: {{description}}\n{{frontmatter}}---\n\n{{body}}\n\n지시: {{pmRole}}\n');
  for (const n of ['XX-a', 'XX-b', 'XX-c']) w(`.claude/ops/roles/${n}.md`, `---\ndescription: ${n} 역할\n---\n- ${n} 본문\n`);

  // 기준 생성(LF) 후 a는 CRLF, b는 LF로 둔다. c는 지운다(새 파일 경우)
  assert.strictEqual(run().status, 0);
  const file = (n) => path.join(root, '.claude', 'agents', `${n}.md`);
  const lf = fs.readFileSync(file('XX-a'), 'utf8');
  assert.ok(!lf.includes('\r'), '새로 만든 파일은 LF');
  fs.writeFileSync(file('XX-a'), lf.replace(/\n/g, '\r\n'));
  fs.rmSync(file('XX-c'));

  // --check: CRLF 파일도 같음, 없는 파일은 다름
  let r = run('--check');
  assert.match(r.stdout, /같음 {2}XX-a/, 'CRLF 파일을 같다고 봐야 함:\n' + r.stdout);
  assert.match(r.stdout, /같음 {2}XX-b/);
  assert.match(r.stdout, /없음 {2}XX-c/);
  assert.strictEqual(r.status, 1);

  // 쓰기: a는 CRLF 유지, b는 LF 유지, c는 새 파일 LF
  assert.strictEqual(run().status, 0);
  assert.strictEqual(fs.readFileSync(file('XX-a'), 'utf8'), lf.replace(/\n/g, '\r\n'), '기존 CRLF 유지');
  assert.ok(!fs.readFileSync(file('XX-b'), 'utf8').includes('\r'), '기존 LF 유지');
  assert.ok(!fs.readFileSync(file('XX-c'), 'utf8').includes('\r'), '새 파일 LF');
  r = run('--check');
  assert.strictEqual(r.status, 0, '다시 쓴 뒤 모두 같음:\n' + r.stdout);

  // BOM이 붙은 CRLF 파일도 같음, 내용이 다르면 종료 코드 1
  fs.writeFileSync(file('XX-b'), '﻿' + fs.readFileSync(file('XX-b'), 'utf8').replace(/\n/g, '\r\n'));
  assert.strictEqual(run('--check').status, 0, 'BOM+CRLF도 같음');
  fs.writeFileSync(file('XX-b'), fs.readFileSync(file('XX-b'), 'utf8').replace('XX-b 본문', '다른 본문'));
  r = run('--check');
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /다름 {2}XX-b/);
  console.log('gen-agents 줄바꿈 검사 통과');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// 자리표시자 필터: |indent는 줄마다 두 칸 들여 써서 하위 목록으로 만든다(빈 줄은 그대로), |size는 MB → GB/MB
{
  const { fill } = require('./gen-agents');
  assert.strictEqual(fill('- 검증:\n{{v|indent}}\n- 다음', { v: '- a\n\n- b' }, 't'), '- 검증:\n  - a\n\n  - b\n- 다음');
  assert.strictEqual(fill('{{m|size}}·{{n|size}}', { m: 1024, n: 500 }, 't'), '1GB·500MB');
  console.log('gen-agents 필터 검사 통과');
}

// 머리글 따옴표: description에 ': '가 들어가면 YAML이 깨져 claude --agent가 역할을 못 찾던 결함(2026-10-09).
// 위험한 값만 큰따옴표로 감싸고, 안전한 값과 본문의 {{description}}은 그대로 둔다.
{
  const { yamlScalar, quoteFrontmatter, generate } = require('./gen-agents');
  assert.strictEqual(yamlScalar('identity-service, 공통 모듈'), 'identity-service, 공통 모듈');
  assert.strictEqual(yamlScalar('개발 도구(`tools/`: VS Code 대시보드)'), '"개발 도구(`tools/`: VS Code 대시보드)"');
  assert.strictEqual(yamlScalar('`frontend/` 담당'), '"`frontend/` 담당"');
  assert.strictEqual(yamlScalar('a #b'), '"a #b"');
  assert.strictEqual(yamlScalar('끝이 콜론:'), '"끝이 콜론:"');
  assert.strictEqual(yamlScalar('true'), '"true"');
  assert.strictEqual(yamlScalar('1.5'), '"1.5"');
  assert.strictEqual(yamlScalar('따옴표 "x" 와 \\'), '따옴표 "x" 와 \\');
  assert.strictEqual(yamlScalar('"따옴표로 시작'), '"\\"따옴표로 시작"');
  assert.strictEqual(yamlScalar('"이미: 감쌈"'), '"이미: 감쌈"');
  assert.strictEqual(yamlScalar("'이미: 감쌈'"), "'이미: 감쌈'");
  assert.strictEqual(yamlScalar('"앞만 따옴표" 뒤: 값'), '"\\"앞만 따옴표\\" 뒤: 값"');
  const out = quoteFrontmatter('---\nname: XX-a\ndescription: 도구(`t/`: 대시보드)\nmodel: x\n---\n\n본문 도구(`t/`: 대시보드)\ndescription: 본문 줄\n');
  assert.strictEqual(out, '---\nname: XX-a\ndescription: "도구(`t/`: 대시보드)"\nmodel: x\n---\n\n본문 도구(`t/`: 대시보드)\ndescription: 본문 줄\n');

  // 생성 전체 경로: 콜론이 든 역할 원본도 머리글은 따옴표로, 본문은 그대로 나온다
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-agents-q-'));
  try {
    const w2 = (rel, text) => { fs.mkdirSync(path.dirname(path.join(r2, rel)), { recursive: true }); fs.writeFileSync(path.join(r2, rel), text); };
    w2('.claude/wy-ops.json', JSON.stringify({ roles: [{ name: 'XX-a' }] }));
    w2('.claude/ops/agent.md', '---\nname: {{name}}\ndescription: {{description}}\n{{frontmatter}}---\n\n{{description}}\n');
    w2('.claude/ops/roles/XX-a.md', '---\ndescription: 도구(`tools/`: 대시보드)\n---\n본문\n');
    const [{ text }] = generate(r2);
    assert.strictEqual(text, '---\nname: XX-a\ndescription: "도구(`tools/`: 대시보드)"\n---\n\n도구(`tools/`: 대시보드)\n');
  } finally {
    fs.rmSync(r2, { recursive: true, force: true });
  }

  // gen-skill(pm-ops SKILL.md)도 같은 머리글 처리: 설정값에 ': '가 들어가면 description을 따옴표로
  const r3 = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-skill-q-'));
  try {
    fs.mkdirSync(path.join(r3, '.claude'));
    fs.writeFileSync(path.join(r3, '.claude', 'wy-ops.json'), JSON.stringify({
      project: 'P: x', pmRole: 'PM', commitRole: 'C', approvals: { namespace: 'p' }, docs: { progress: 'a.md', decisions: 'b.md' },
      memory: { blockFreeMB: 500, warnFreeMB: 1024 }, rotation: { transcriptMB: 2 },
    }));
    const head = require('./gen-skill').generate(r3).split('\n').slice(0, 4);
    assert.strictEqual(head[1], 'name: pm-ops');
    assert.ok(/^description: "P: x의 PM\(/.test(head[2]), head[2]);
    assert.strictEqual(head[3], '---');
  } finally {
    fs.rmSync(r3, { recursive: true, force: true });
  }
  console.log('gen-agents 머리글 따옴표 검사 통과');
}
