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

// '## 스킬 쓰는 때'(templates/skills.json, SKL D-23): template → group → 이름(접두사·끝 숫자 뗌) 순, 없거나 빈 목록이면 빈 문자열
{
  const { skillNotes } = require('./gen-agents');
  assert.ok(/^## 스킬 쓰는 때\n- .*code-review/.test(skillNotes({ name: 'AB-backend2' })) && skillNotes({ name: 'AB-backend2' }).endsWith('\n\n'));
  assert.ok(skillNotes({ name: 'AB-x', group: 'qa' }).includes('git archive'));
  assert.ok(skillNotes({ name: 'AB-x', template: 'frontend', group: 'qa' }).includes('simplify'), 'template이 group보다 먼저');
  for (const role of [{ name: 'AB-commit' }, { name: 'AB-design' }, { name: 'AB-search' }, { name: 'AB-pm' }]) assert.strictEqual(skillNotes(role), '', role.name);
  console.log('gen-agents 스킬 절 검사 통과');
}

// disallowedTools(templates/context.json, TOK-4): 표준 줄을 넣고, design·frontend는 Artifact를 남기며, 원본 줄이 있으면 그것을 쓴다(빈 값이면 줄 없음)
{
  const { toolsFrontmatter } = require('./gen-agents');
  const fm = 'name: AB-x\n';
  const line = (role) => (toolsFrontmatter(role, fm).match(/^disallowedTools: (.*)$/m) || [])[1] || '';
  assert.ok(/^name: AB-x\ndisallowedTools: .*Workflow/.test(toolsFrontmatter({ name: 'AB-backend' }, fm)));
  assert.ok(line({ name: 'AB-backend' }).includes('Artifact'));
  assert.ok(!line({ name: 'AB-design' }).includes('Artifact') && line({ name: 'AB-design' }).includes('Workflow'));
  assert.ok(!line({ name: 'AB-x', group: 'frontend' }).includes('Artifact'));
  assert.strictEqual(toolsFrontmatter({ name: 'AB-x' }, 'name: AB-x\ndisallowedTools: Bash\n'), 'name: AB-x\ndisallowedTools: Bash\n', '원본 줄 그대로');
  for (const v of ['', ' []', ' ""']) assert.strictEqual(toolsFrontmatter({ name: 'AB-x' }, `name: AB-x\ndisallowedTools:${v}\n`), 'name: AB-x\n', `빈 값이면 줄 없음: ${v}`);
  assert.ok(!line({ name: 'AB-pm' }).includes('AskUserQuestion') && line({ name: 'AB-pm' }).includes('Artifact'), 'pm은 AskUserQuestion을 남김');
  console.log('gen-agents disallowedTools 검사 통과');
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
    const tools = require('./templates/context.json').disallowedTools.join(', ');
    assert.strictEqual(text, `---\nname: XX-a\ndescription: "도구(\`tools/\`: 대시보드)"\ndisallowedTools: ${tools}\n---\n\n도구(\`tools/\`: 대시보드)\n`);
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
    // 함께 만드는 스킬(templates/skills/, SKL D-22): 설정값이 채워지고 /ecc: 명령에 기대지 않음
    const extra = require('./gen-skill').generateExtra(r3);
    assert.deepStrictEqual(extra.map((e) => e.name), ['wy-resume-session', 'wy-save-session']);
    for (const e of extra) {
      assert.ok(e.text.startsWith(`---\nname: ${e.name}\n`) && e.text.includes('PM') && e.text.includes('a.md') && !/\{\{|\/ecc:/.test(e.text), e.name);
    }
  } finally {
    fs.rmSync(r3, { recursive: true, force: true });
  }
  console.log('gen-agents 머리글 따옴표 검사 통과');
}

// worktree 문구(S4 5단계, WT-09): 꺼진 프로젝트는 예전 문구와 글자까지 같고, 켜지면 역할마다(worktree·commit·pm) 다르다.
// 켜짐 판정은 session.ps1과 같다: 키가 없으면 켬, enabled를 적었으면 true일 때만, roles가 있으면 그 목록
{
  const wt = require('./lib/worktree');
  const base = { pmRole: 'XX-pm', commitRole: 'XX-commit' };
  const off = { ...base, worktree: { enabled: false } };
  assert.strictEqual(wt.isOn(base), true, '키 없으면 켬');
  assert.strictEqual(wt.isOn({ ...base, worktree: {} }), true, 'enabled 없으면 켬');
  assert.strictEqual(wt.isOn({ ...base, worktree: { enabled: 'yes' } }), false, 'true가 아니면 끔');
  assert.strictEqual(wt.isOn(off), false);
  assert.deepStrictEqual(['true', 'TRUE', 1, 'false', 0].map((v) => wt.isOn({ worktree: { enabled: v } })), [true, true, true, false, false], 'PowerShell -eq $true와 같음');
  assert.deepStrictEqual(['XX-a', 'XX-b'].map((n) => wt.isWtRole({ ...base, worktree: { roles: 'XX-b' } }, n)), [false, true], 'roles 문자열 하나도 목록');
  assert.throws(() => wt.agentRules({ pmRole: 'XX-pm' }, 'XX-a'), /commitRole/, 'commitRole 없으면 멈춤');
  assert.deepStrictEqual(['XX-a', 'XX-pm', 'XX-commit'].map((n) => wt.isWtRole(base, n)), [true, false, false], 'pm·commit은 본 저장소');
  assert.deepStrictEqual(['XX-a', 'XX-b'].map((n) => wt.isWtRole({ ...base, worktree: { roles: ['XX-b'] } }, n)), [false, true], 'roles로 고름');
  assert.strictEqual(wt.isWtRole(off, 'XX-a'), false);
  assert.strictEqual(wt.agentRules(off, 'XX-a'), '- 워킹트리는 모든 세션이 함께 쓴다. `git stash`·`checkout`·`restore`·`reset`·`clean` 금지. 일부 파일만 검증하려면 `git archive`로 사본을 만들어 그 안에서 돌린다. 커밋은 커밋 전담 세션(`XX-commit`)에 요청하고, 요청한 파일은 완료 회신 전까지 고치지 않는다.', '꺼짐: 예전 문구 그대로');
  assert.strictEqual(wt.agentRules(off, 'XX-commit'), wt.agentRules(off, 'XX-a'), '꺼짐: 역할마다 같음');
  assert.deepStrictEqual(wt.claudeMdRules(off), { treeRules: '- 워킹트리는 모든 세션이 함께 쓴다. `git stash`·`checkout`·`restore`·`reset`·`clean`처럼 워킹트리 파일을 바꾸는 git 명령은 쓰지 않는다. 일부 파일만으로 검증하려면 `git archive` 등으로 사본을 만들어 그 안에서 돌린다.', commitTreeRules: '' });
  assert.strictEqual(wt.skillRules(off), '- 커밋을 요청한 파일은 완료 회신 전까지 아무도 고치지 않는다. 공유 워킹트리에서 stash·checkout·restore·reset·clean 금지.');
  const a = wt.agentRules(base, 'XX-a');
  assert.ok(a.includes('`.claude/worktrees/XX-a`(가지 `wt/XX-a`)') && !a.includes('git archive`로 사본을'), '켜짐: 자기 worktree');
  assert.ok(wt.agentRules(base, 'XX-commit').includes('git merge --no-ff wt/<역할>'), '켜짐: commit은 병합 흐름');
  assert.ok(wt.agentRules(base, 'XX-pm').startsWith('- 이 세션은 본 저장소에서 돈다') && !wt.agentRules(base, 'XX-pm').includes('--no-ff'), '켜짐: pm은 본 저장소');
  assert.ok(wt.claudeMdRules(base).commitTreeRules.startsWith('\n- '), '켜짐: 커밋 절에 한 줄 더함');
  // 기본 템플릿이 자리표시자를 쓴다(예전 문구가 남아 두 번 나오지 않게)
  for (const [f, key] of [['templates/agent.md', '{{treeRules}}'], ['templates/claude-md.md', '{{treeRules}}'], ['templates/claude-md.md', '{{commitTreeRules}}'], ['templates/pm-ops/SKILL.md', '{{treeRules}}']]) {
    const t = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(t.includes(key) && !t.includes('워킹트리는 모든 세션이 함께') && !t.includes('공유 워킹트리에서'), `${f}: ${key}`);
  }
  console.log('gen-agents worktree 문구 검사 통과');
}
