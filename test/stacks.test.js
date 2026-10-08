// 스택 템플릿(templates/stacks/*.json) 형식 검사 + 실제 템플릿으로 init(스택·검증 명령 덮어쓰기·CLAUDE.part.md)
//   node test/stacks.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmTree } = require('../lib/fsx');
const { init, listStacks, loadStack } = require('../lib/init');
const { VERIFY_KEYS } = require('../gen-agents');
const { toolCmds } = require('../lib/doctor');

const T = path.join(__dirname, '..', 'templates');
const KEYS = VERIFY_KEYS.map(([k]) => k);
const BANNED = [/WY-/, /\berp\b/i, /worklog/i];
const DEFAULT_NAMES = ['commit', 'pm', 'planner', 'backend1', 'backend2', 'frontend1', 'frontend2', 'qa', 'design', 'browser'].map((n) => `AB-${n}`);

// 1. 형식: id=파일 이름, verify 6키(문자열|null), tools, 메모 3줄 이하. 역할 구성은 스택이 아니라 roles.json(공통)
const stacks = listStacks(T);
assert.ok(stacks.length >= 6, `스택 수: ${stacks.length}`);
for (const { id } of stacks) {
  const raw = fs.readFileSync(path.join(T, 'stacks', `${id}.json`), 'utf8');
  for (const re of BANNED) assert.ok(!re.test(raw), `${id}: 금지 문자열 ${re}`);
  const s = loadStack(T, id, { prefix: 'AB-', project: 'demo' });
  assert.strictEqual(s.id, id);
  assert.ok(s.label, `${id}: label`);
  assert.deepStrictEqual(Object.keys(s.verify).sort(), [...KEYS].sort(), `${id}: verify 키`);
  for (const k of KEYS) assert.ok(s.verify[k] === null || (typeof s.verify[k] === 'string' && s.verify[k].trim()), `${id}.verify.${k}`);
  assert.deepStrictEqual(Object.keys(s).filter((k) => !['id', 'label', 'tools', 'verify', 'notes'].includes(k)), [], `${id}: 모르는 키(역할은 roles.json)`);
  assert.ok(Array.isArray(s.tools) && s.tools.every((t) => toolCmds(t) && t.label && t.install), `${id}: tools [{cmd|anyOf,label,install}]`);
  assert.ok(!s.notes || (Array.isArray(s.notes) && s.notes.length <= 3), `${id}: notes 3줄 이하`);
}
assert.throws(() => loadStack(T, 'nope', {}), /스택이 없습니다: nope .*node/);
assert.throws(() => loadStack(T, '../x', {}), /스택이 없습니다/);

// 2. 실제 템플릿으로 init: 스택 역할·검증 명령(덮어쓰기)·역할 파일·CLAUDE.part.md
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-stacks-'));
try {
  for (const { id } of stacks) {
    const P = path.join(tmp, id);
    fs.mkdirSync(P);
    const over = id === 'cpp' ? { test: 'ctest --test-dir out -C Debug' } : {};
    const r = init({ project: P, name: `demo-${id}`, prefix: 'AB-', stack: id, verify: over, templatesDir: T, version: '0.7.0' });
    const ops = JSON.parse(fs.readFileSync(path.join(P, '.claude', 'wy-ops.json'), 'utf8'));
    const st = loadStack(T, id, { prefix: 'AB-', project: `demo-${id}` });
    assert.strictEqual(ops.stack, id);
    assert.deepStrictEqual(ops.tools, st.tools, `${id}: tools 복사`);
    assert.deepStrictEqual(ops.roles.map((x) => x.name), DEFAULT_NAMES, `${id}: 기본 역할 구성`);
    for (const k of KEYS) assert.strictEqual(ops.verify[k], over[k] || st.verify[k], `${id}.verify.${k}`);
    for (const role of ops.roles.filter((x) => x.agent)) {
      const agent = fs.readFileSync(path.join(P, '.claude', 'agents', `${role.name}.md`), 'utf8');
      assert.ok(agent.includes(`name: ${role.name}`), `${id}: ${role.name} 역할 파일`);
      assert.ok(agent.includes('## 검증 명령'), `${id}: 역할 파일에 검증 명령 절`);
      if (over.test) assert.ok(agent.includes(over.test), '덮어쓴 명령이 역할 파일에');
    }
    const part = fs.readFileSync(path.join(P, '.claude', 'ops', 'CLAUDE.part.md'), 'utf8');
    assert.strictEqual(part, r.claudeMd.trim() + '\n');
    assert.ok(part.includes('`AB-pm`') && part.includes('`AB-commit`'), `${id}: CLAUDE 절에 역할 표`);
    assert.ok(!/\{\{/.test(part), `${id}: 채우지 못한 자리표시`);
    for (const re of BANNED) assert.ok(!re.test(part), `${id}: CLAUDE 절 금지 문자열 ${re}`);
    const firstCmd = KEYS.map((k) => ops.verify[k]).find(Boolean);
    if (firstCmd) assert.ok(part.includes(firstCmd), `${id}: CLAUDE 절에 검증 명령`);
    else assert.ok(part.includes('아직 정하지 않았다'), `${id}: 검증 명령 없음 안내`);
  }

  // 3. 역할 구성: 수·담당 영역·고르기, 작업 원칙 끄기
  {
    const P = path.join(tmp, 'roles-x');
    fs.mkdirSync(P);
    const r = init({ project: P, name: 'demo', prefix: 'AB-', stack: 'node', counts: { backend: 3, frontend: 1, qa: 2 }, areas: { 'AB-backend1': 'server/api', 'AB-backend2': 'server/batch' }, roles: ['backend', 'frontend', 'qa'], principles: false, templatesDir: T });
    const names = r.ops.roles.map((x) => x.name);
    assert.deepStrictEqual(names, ['AB-commit', 'AB-pm', 'AB-backend1', 'AB-backend2', 'AB-backend3', 'AB-frontend', 'AB-qa1', 'AB-qa2']);
    const b1 = fs.readFileSync(path.join(P, '.claude', 'agents', 'AB-backend1.md'), 'utf8');
    const b3 = fs.readFileSync(path.join(P, '.claude', 'agents', 'AB-backend3.md'), 'utf8');
    assert.ok(b1.includes('담당: server/api.') && b1.includes('공용 파일은 이 세션이 맡는다'), b1.slice(0, 400));
    assert.ok(b3.includes('pm이 배정') && b3.includes('`AB-backend1`에 요청') && b3.includes('`AB-backend2`(`server/batch`)'));
    assert.ok(!fs.readFileSync(path.join(P, '.claude', 'agents', 'AB-frontend.md'), 'utf8').includes('## 담당 영역'), '1개면 영역 절 없음');
    const part = r.claudeMd;
    assert.ok(part.includes('`AB-backend1`·`AB-backend2`·`AB-backend3`는 같은 역할을') && part.includes('`AB-qa1`·`AB-qa2`'), '병렬 규칙');
    assert.ok(part.includes('| `AB-backend1` | 백엔드: 서버·공통 모듈·빌드 — 담당 `server/api`, 같은 역할의 공용 파일 담당 |'), '역할 표에 영역');
    assert.ok(!part.includes('## 작업 원칙') && !/\n{3,}/.test(part), '원칙 끔, 빈 줄 정리');
    assert.ok(init({ project: path.join(tmp, 'roles-y'), name: 'demo', prefix: 'AB-', templatesDir: T }).claudeMd.includes('## 작업 원칙'), '원칙 기본 포함');
    const bad = (o, re) => assert.throws(() => init({ project: path.join(tmp, 'bad'), name: 'demo', prefix: 'AB-', templatesDir: T, ...o }), re);
    bad({ counts: { design: 2 } }, /여러 개로 나눌 수 없습니다/);
    bad({ counts: { backend: 9 } }, /0~4/);
    bad({ counts: { commit: 0 } }, /꼭 1개/);
    bad({ roles: ['search'] }, /모르는 역할: search/);
    bad({ areas: { 'AB-design': 'x' } }, /여러 개로 나눈 역할에만/);
  }
} finally {
  rmTree(tmp);
}
console.log(`stacks.test: ${stacks.length}개 스택 통과`);
