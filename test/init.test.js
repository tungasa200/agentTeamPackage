// init(OPS-10-2) 검사: 빈 프로젝트에 파일 생성, 다시 하면 그대로, 기존 파일·사람이 고친 파일은 덮지 않음
//   node tools/wy-ops/test/init.test.js
// 템플릿은 임시 폴더의 최소본을 쓴다(실제 템플릿 문구는 WY-backend1 담당, 형식만 같으면 된다)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmTree } = require('../lib/fsx');
const { init } = require('../lib/init');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-init-'));
const T = path.join(tmp, 'templates');
const put = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const R = (p, rel) => fs.readFileSync(path.join(p, rel), 'utf8');

try {
  put(T, 'wy-ops.json', JSON.stringify({
    schema: 1, project: '{{project}}', product: 'X', rolePrefix: '{{prefix}}', pmRole: '{{prefix}}pm', commitRole: '{{prefix}}commit',
    roles: [
      { name: '{{prefix}}commit', summary: '커밋 전담', agent: true },
      { name: '{{prefix}}pm', summary: '총괄', agent: false },
      { name: '{{prefix}}qa', summary: '테스트', agent: true },
    ],
    rotation: { transcriptMB: 5 }, memory: { warnFreeMB: 1024, blockFreeMB: 500 },
    approvals: { namespace: '{{project}}', ttlMinutes: 60 }, docs: { progress: 'docs/진행현황.md', decisions: 'docs/결정기록.md' },
  }));
  put(T, 'roles.json', JSON.stringify({ groups: [
    { id: 'commit', summary: '커밋 전담', template: 'commit', count: 1, fixed: true },
    { id: 'pm', summary: '총괄', agent: false, count: 1, fixed: true },
    { id: 'qa', summary: '테스트', template: 'qa', count: 1, multi: true },
  ] }));
  put(T, 'roles/commit.md', '---\ndescription: 커밋 전담({{project}}).\n---\n- {{prefix}}pm에 보고한다.\n');
  put(T, 'roles/qa.md', '---\ndescription: 테스트.\n---\n- 코드를 고치지 않는다.\n');
  put(T, 'pm-ops.project.md', '## 프로젝트 부록 — {{project}}\n- 여기에 이 프로젝트 규칙\n');
  put(T, 'claude-md.md', '## 세션 역할\n\n{{rolesTable}}\n');
  put(T, 'gitignore.txt', '# WY Ops\n.claude/settings.local.json\n.claude/wy-ops.local.json\n.claude/*.bak-*\n');

  // 1. 빈 프로젝트(기존 CLAUDE.md·.gitignore 한 줄)
  const P = path.join(tmp, 'proj');
  put(P, 'CLAUDE.md', '# 내 프로젝트\n');
  put(P, '.gitignore', 'node_modules\n.claude/wy-ops.local.json\n');
  const r1 = init({ project: P, name: 'sandbox', prefix: 'SB-', templatesDir: T, version: '0.6.0' });
  const ops = JSON.parse(R(P, '.claude/wy-ops.json'));
  assert.deepStrictEqual([ops.project, ops.pmRole, ops.commitRole, ops.approvals.namespace], ['sandbox', 'SB-pm', 'SB-commit', 'sandbox']);
  assert.ok(R(P, '.claude/ops/roles/SB-commit.md').includes('커밋 전담(sandbox)') && R(P, '.claude/ops/roles/SB-commit.md').includes('SB-pm에 보고'));
  assert.ok(!fs.existsSync(path.join(P, '.claude/ops/roles/SB-pm.md')), 'agent:false 역할은 원본을 만들지 않음');
  assert.ok(R(P, '.claude/agents/SB-commit.md').includes('name: SB-commit'), 'gen-agents 실행');
  assert.ok(R(P, '.claude/skills/pm-ops/SKILL.md').includes('프로젝트 부록 — sandbox'), 'gen-skill이 부록을 붙임');
  assert.ok(fs.existsSync(path.join(P, '.claude/skills/pm-ops/scripts/session.ps1')), 'session.ps1 생성');
  assert.strictEqual(R(P, 'CLAUDE.md'), '# 내 프로젝트\n', 'CLAUDE.md는 고치지 않음');
  assert.ok(r1.claudeMd.includes('| `SB-commit` | 커밋 전담 |'), 'CLAUDE.md에 넣을 역할 표');
  assert.deepStrictEqual(r1.gitignoreAdded, ['.claude/settings.local.json', '.claude/*.bak-*'], '빠진 줄만');
  assert.strictEqual(R(P, '.gitignore').split('.claude/wy-ops.local.json').length, 2, '있는 줄은 다시 넣지 않음');
  const lock = JSON.parse(R(P, '.claude/wy-ops.lock.json'));
  assert.ok(lock.files['.claude/agents/SB-commit.md'] && lock.files['.claude/ops/roles/SB-qa.md'] && lock.version === '0.6.0', 'lock에 생성 파일');

  // 2. 다시 하면: 같음, .gitignore 그대로
  const gi = R(P, '.gitignore');
  const r2 = init({ project: P, name: 'sandbox', prefix: 'SB-', templatesDir: T });
  assert.ok(r2.files.filter((f) => f.file !== '.claude/wy-ops.json').every((f) => f.action === 'same'), JSON.stringify(r2.files));
  assert.strictEqual(R(P, '.gitignore'), gi);

  // 3. 사람이 고친 역할 원본은 덮지 않음
  fs.writeFileSync(path.join(P, '.claude/ops/roles/SB-qa.md'), '---\ndescription: 손으로 고침.\n---\n- 우리 규칙\n');
  const r3 = init({ project: P, name: 'sandbox', prefix: 'SB-', templatesDir: T });
  assert.strictEqual(r3.files.find((f) => f.file === '.claude/ops/roles/SB-qa.md').action, 'modified');
  assert.ok(R(P, '.claude/ops/roles/SB-qa.md').includes('손으로 고침'));

  // 4. 이미 wy-ops.json이 있는 프로젝트: 그 설정을 쓰고 덮지 않음, --roles로 고른 역할(+커밋 역할)만
  const Q = path.join(tmp, 'q');
  const r4 = init({ project: Q, name: 'q', prefix: 'Q-', roles: ['qa'], templatesDir: T });
  assert.deepStrictEqual(r4.ops.roles.map((r) => r.name), ['Q-commit', 'Q-pm', 'Q-qa'], '고른 역할 + pm + 커밋');
  const before = R(Q, '.claude/wy-ops.json');
  const r5 = init({ project: Q, name: 'other', prefix: 'Q-', templatesDir: T });
  assert.strictEqual(R(Q, '.claude/wy-ops.json'), before, '있는 설정은 덮지 않음');
  assert.strictEqual(r5.files.find((f) => f.file === '.claude/wy-ops.json').action, 'unmanaged');

  // 5. 입력 검사
  assert.throws(() => init({ project: Q, name: 'a b', prefix: 'Q-', templatesDir: T }), /프로젝트 이름/);
  assert.throws(() => init({ project: Q, name: 'q', prefix: 'Q', templatesDir: T }), /접두사/);
  console.log('wy-ops init 검사 통과');
} finally {
  rmTree(tmp);
}
