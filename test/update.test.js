// update(OPS-10-3)와 init용 템플릿 검사: 템플릿으로 새 프로젝트를 init처럼 꾸민 뒤 update가 생성 파일을 만들고,
// 다시 하면 바꿀 것이 없고, 사람이 고친 파일·관리 밖 파일은 덮지 않고 차이만 보이는지 본다. 임시 폴더에서만.
//   node tools/wy-ops/test/update.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const { rmTree, copyTree } = require('../lib/fsx');
const path = require('path');
const { update, format } = require('../lib/update');
const lock = require('../lib/lock');
const { GITIGNORE_LINES } = require('../lib/doctor');

const T = path.join(__dirname, '..', 'templates');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-update-'));
const fillIn = (text) => text.replace(/\{\{project\}\}/g, 'sandbox').replace(/\{\{prefix\}\}/g, 'SB-');
const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

try {
  // 0. 템플릿 자체: init이 바꾸는 자리표시자만 쓰고, 설정이 doctor 기준에 맞고, .gitignore 줄이 doctor와 같다
  const opsText = fs.readFileSync(path.join(T, 'wy-ops.json'), 'utf8');
  const ops = JSON.parse(fillIn(opsText));
  assert.ok(!('roles' in ops), '역할은 roles.json에서 펼침');
  const { expandRoles } = require('../lib/init');
  const catalog = JSON.parse(fs.readFileSync(path.join(T, 'roles.json'), 'utf8'));
  assert.deepStrictEqual(expandRoles(catalog, { prefix: 'SB-' }).map((r) => r.name.replace('SB-', '')), ['commit', 'pm', 'planner', 'backend1', 'backend2', 'frontend1', 'frontend2', 'qa', 'design', 'browser'], '기본 구성(카드 1040)');
  for (const g of catalog.groups) if (g.template) assert.ok(fs.existsSync(path.join(T, 'roles', `${g.template}.md`)), `roles/${g.template}.md`);
  ops.roles = expandRoles(catalog, { prefix: 'SB-', counts: { backend: 1, frontend: 1 } });
  const names = ops.roles.map((r) => r.name);
  assert.ok(names.includes(ops.pmRole) && names.includes(ops.commitRole), 'pm·커밋 역할이 roles에 있음');
  assert.deepStrictEqual(ops.roles.map((r) => [r.name.replace('SB-', ''), r.agent]), [['commit', true], ['pm', false], ['planner', true], ['backend', true], ['frontend', true], ['qa', true], ['design', true], ['browser', true]], '1개씩 고른 역할');
  assert.strictEqual(ops.approvals.namespace, 'sandbox');
  assert.ok(!('handoff' in ops), 'handoff 없음');
  assert.deepStrictEqual(fs.readFileSync(path.join(T, 'gitignore.txt'), 'utf8').trim().split(/\r?\n/), GITIGNORE_LINES, '.gitignore 줄 = doctor 기준');
  const claudeMd = fs.readFileSync(path.join(T, 'claude-md.md'), 'utf8');
  assert.ok(claudeMd.includes('{{rolesTable}}'), 'CLAUDE.md 절에 역할 표 자리');
  // CLAUDE.md 절은 설정 값(pmRole·commitRole·memory 등)으로 채운다: 채워지면 됨
  require('../gen-agents').fill(claudeMd, { ...ops, project: 'sandbox', prefix: 'SB-', rolesTable: '-', verifyList: '-', parallelRules: '-', principles: '' }, 'claude-md.md');
  for (const f of ['wy-ops.json', 'pm-ops.project.md', ...fs.readdirSync(path.join(T, 'roles')).map((n) => `roles/${n}`)]) {
    const left = (fs.readFileSync(path.join(T, f), 'utf8').match(/\{\{[^}]+\}\}/g) || []).filter((p) => !['{{project}}', '{{prefix}}', '{{rolesTable}}'].includes(p));
    assert.deepStrictEqual(left, [], `${f}: init이 모르는 자리표시자 없음`);
    assert.ok(!/worklog|railway|vercel|erp-project/i.test(fs.readFileSync(path.join(T, f), 'utf8')), `${f}: 이 프로젝트 고유 내용 없음`);
  }

  // init처럼 꾸민 새 프로젝트
  const project = path.join(base, 'sandbox');
  write(path.join(project, '.claude', 'wy-ops.json'), JSON.stringify(ops, null, 2));
  for (const r of ops.roles.filter((x) => x.agent)) write(path.join(project, '.claude', 'ops', 'roles', `${r.name}.md`), fillIn(fs.readFileSync(path.join(T, 'roles', `${r.name.replace('SB-', '')}.md`), 'utf8')));
  write(path.join(project, '.claude', 'ops', 'pm-ops.project.md'), fillIn(fs.readFileSync(path.join(T, 'pm-ops.project.md'), 'utf8')));

  // 1. 처음: 모두 새로 만듦, lock에 해시
  const first = update({ project, version: '0.6.0' });
  // session.ps1 코어 템플릿은 WY-backend2가 옮겨 오는 중이라, 있을 때만 대상이다
  const hasPs1 = fs.existsSync(path.join(T, 'pm-ops', 'scripts', 'session.ps1'));
  const want = ['.claude/agents/SB-backend.md', '.claude/agents/SB-browser.md', '.claude/agents/SB-commit.md', '.claude/agents/SB-design.md', '.claude/agents/SB-frontend.md', '.claude/agents/SB-planner.md', '.claude/agents/SB-qa.md', '.claude/skills/pm-ops/SKILL.md', ...(hasPs1 ? ['.claude/skills/pm-ops/scripts/session.ps1'] : [])];
  assert.deepStrictEqual(first.map((r) => r.file).sort(), want, '생성 파일 목록(pm은 역할 파일 없음)');
  assert.ok(first.every((r) => r.action === 'create'), '처음엔 모두 create');
  const agent = fs.readFileSync(path.join(project, '.claude', 'agents', 'SB-commit.md'), 'utf8');
  assert.ok(agent.includes('name: SB-commit') && agent.includes('`SB-pm`에 알린다') && agent.includes('sandbox'), '역할 파일에 이름·pm·프로젝트');
  assert.ok(fs.readFileSync(path.join(project, '.claude', 'skills', 'pm-ops', 'SKILL.md'), 'utf8').includes('## 프로젝트 부록 (sandbox)'), '스킬에 부록');
  const l = lock.readLock(project);
  assert.strictEqual(l.version, '0.6.0');
  assert.deepStrictEqual(Object.keys(l.files).sort(), want, 'lock에 모두');

  // 2. 다시 하면 바꿀 것 없음
  assert.ok(update({ project }).every((r) => r.action === 'same'), '다시 하면 same');

  // 3. 원본이 바뀌면(역할 문구 수정) lock과 같은 생성 파일은 고친다
  const roleSrc = path.join(project, '.claude', 'ops', 'roles', 'SB-qa.md');
  fs.appendFileSync(roleSrc, '- 새 규칙 한 줄\n');
  const third = update({ project });
  assert.strictEqual(third.find((r) => r.file.endsWith('SB-qa.md')).action, 'update', '원본 변경 → update');
  assert.ok(fs.readFileSync(path.join(project, '.claude', 'agents', 'SB-qa.md'), 'utf8').includes('새 규칙 한 줄'), '반영됨');

  // 4. 사람이 생성 파일을 고쳤으면 덮지 않고 차이만
  const handFile = path.join(project, '.claude', 'agents', 'SB-backend.md');
  const handText = fs.readFileSync(handFile, 'utf8').replace('백엔드', '백엔드(손으로 고침)');
  fs.writeFileSync(handFile, handText);
  fs.appendFileSync(path.join(project, '.claude', 'ops', 'roles', 'SB-backend.md'), '- 원본에도 새 줄\n');
  const fourth = update({ project });
  const hand = fourth.find((r) => r.file.endsWith('SB-backend.md'));
  assert.strictEqual(hand.action, 'modified', '사람이 고침');
  assert.ok(hand.diff.includes('- ') && hand.diff.includes('+ ') && hand.diff.includes('손으로 고침'), '차이 앞부분');
  assert.strictEqual(fs.readFileSync(handFile, 'utf8'), handText, '덮지 않음');
  assert.ok(format(fourth).includes('사람이 고친 파일이라 그대로 둠'), '표시 문구');

  // 5. lock에 없는데 이미 있는 파일(관리 밖)도 덮지 않는다, dryRun은 아무것도 쓰지 않는다
  const other = path.join(base, 'other');
  copyTree(project, other);
  rmTree(path.join(other, lock.LOCK));
  fs.writeFileSync(path.join(other, '.claude', 'skills', 'pm-ops', 'SKILL.md'), '# 원래 있던 스킬\n');
  const before = fs.readFileSync(path.join(other, '.claude', 'skills', 'pm-ops', 'SKILL.md'), 'utf8');
  const dry = update({ project: other, dryRun: true });
  assert.strictEqual(dry.find((r) => r.file.endsWith('SKILL.md')).action, 'unmanaged', '관리 밖');
  assert.ok(!fs.existsSync(path.join(other, lock.LOCK)), 'dryRun은 lock도 안 씀');
  update({ project: other });
  assert.strictEqual(fs.readFileSync(path.join(other, '.claude', 'skills', 'pm-ops', 'SKILL.md'), 'utf8'), before, '관리 밖 파일 그대로');

  // 6. 설정이 없으면 알기 쉬운 오류
  assert.throws(() => update({ project: path.join(base, 'empty') }), /init을 먼저/);

  console.log('update 검사 통과');
} finally {
  rmTree(base);
}
