// lib/projects.js(D-39): ~/.claude.json projects 가운데 wy-ops 프로젝트 찾기·겹침 판정·겹치지 않는 접두사. 임시 홈에서만
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const p = require('../lib/projects');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-projects-'));
const put = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
};
try {
  const home = path.join(tmp, 'home');
  assert.deepStrictEqual(p.list(home), [], '~/.claude.json 없으면 빈 목록');
  const A = path.join(tmp, 'alpha');
  const B = path.join(tmp, 'beta');
  const plain = path.join(tmp, 'plain');
  put(path.join(A, '.claude', 'wy-ops.json'), { project: 'alpha', rolePrefix: 'AL-', pmRole: 'AL-pm', approvals: { namespace: 'alpha' } });
  put(path.join(A, '.claude', 'wy-ops.local.json'), { approvals: { namespace: 'alpha-local' } });
  put(path.join(B, '.claude', 'wy-ops.json'), { project: 'beta', pmRole: 'BEpm', approvals: { namespace: 'beta' } });
  fs.mkdirSync(plain, { recursive: true });
  const wtA = path.join(A, '.claude', 'worktrees', 'AL-dev');
  put(path.join(wtA, '.claude', 'wy-ops.json'), { project: 'alpha', rolePrefix: 'AL-' });
  const fwd = (d) => d.replace(/\\/g, '/');
  put(path.join(home, '.claude.json'), { projects: { [fwd(A)]: {}, [A.toUpperCase()]: {}, [fwd(B)]: {}, [plain]: {}, [fwd(wtA)]: {}, [path.join(tmp, 'gone')]: {} } });

  const l = p.list(home);
  assert.deepStrictEqual(l.map((x) => x.project), ['alpha', 'beta'], `설정 있는 폴더만, worktree·중복(대소문자) 뺌: ${JSON.stringify(l)}`);
  assert.deepStrictEqual(l[0], { dir: path.resolve(A), project: 'alpha', rolePrefix: 'AL-', pmRole: 'AL-pm', namespace: 'alpha-local' }, 'local 덮어쓰기까지 합친 값');
  assert.strictEqual(l[1].rolePrefix, null);

  assert.strictEqual(p.mainRoot(wtA), A, 'worktree → 본 저장소');
  assert.strictEqual(p.mainRoot(A), A);
  assert.deepStrictEqual(p.others(wtA, home).map((x) => x.project), ['beta'], 'worktree에서도 자기 프로젝트는 뺌');

  assert.ok(p.prefixClash('AL-', 'al-') && p.prefixClash('BE', 'BEpm') && !p.prefixClash('AL-', 'ALP-') && !p.prefixClash('', 'X-'));
  const c = p.conflicts({ rolePrefix: 'BE', namespace: 'ALPHA-local' }, l);
  assert.deepStrictEqual(c.map((x) => `${x.project}:${x.why}`), ['alpha:namespace', 'beta:prefix'], JSON.stringify(c));
  assert.deepStrictEqual(p.conflicts({ pmRole: 'GA-pm', namespace: 'gamma' }, l), [], 'rolePrefix 없으면 pmRole로');

  assert.strictEqual(p.freePrefix('my-app', []), 'MY-');
  assert.strictEqual(p.freePrefix('x', []), 'X-');
  assert.strictEqual(p.freePrefix('', []), 'WY-');
  const taken = (...ps) => ps.map((x) => ({ rolePrefix: x }));
  assert.strictEqual(p.freePrefix('erp2', taken('ER-')), 'ERP-', '2자가 겹치면 3자');
  assert.strictEqual(p.freePrefix('erp2', taken('ER-', 'erp-')), 'ER2-', '3자도 겹치면 숫자');
  assert.strictEqual(p.freePrefix('er', taken('ER-')), 'ER2-', '3자가 없으면 바로 숫자');
  console.log('projects 검사 통과');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
