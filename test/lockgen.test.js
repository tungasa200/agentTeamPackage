// 생성기와 lock: gen-agents·gen-skill로 다시 만들면 lock도 맞춰지고(어긋나지 않음), 사람이 생성물을 고친 것만 어긋난다
//   node tools/wy-ops/test/lockgen.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { rmTree } = require('../lib/fsx');
const { init } = require('../lib/init');
const lock = require('../lib/lock');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-lockgen-'));
const P = path.join(tmp, 'proj');
const gen = (script, ...extra) => execFileSync(process.execPath, [path.join(__dirname, '..', script), '--root', P, ...extra], { encoding: 'utf8' });
try {
  init({ project: P, name: 'lockgen', prefix: 'LG-' });
  assert.deepStrictEqual(lock.drift(P), [], 'init 직후 어긋남 없음');

  // 1. 역할 원본을 고치고 gen-agents로 다시 만들면: 생성물이 바뀌어도 lock이 따라와 어긋나지 않음(84cd6e5 결함)
  const role = path.join(P, '.claude', 'ops', 'roles', 'LG-qa.md');
  fs.appendFileSync(role, '- 원본에 한 줄 더함\n');
  const before = lock.readLock(P).files['.claude/agents/LG-qa.md'];
  gen('gen-agents.js');
  assert.ok(fs.readFileSync(path.join(P, '.claude', 'agents', 'LG-qa.md'), 'utf8').includes('원본에 한 줄 더함'));
  assert.notStrictEqual(lock.readLock(P).files['.claude/agents/LG-qa.md'], before, 'lock 항목 갱신');
  assert.deepStrictEqual(lock.drift(P), [], 'gen-agents 뒤 어긋남 없음');

  // 2. pm-ops 부록을 고치고 gen-skill: SKILL.md 항목도 따라옴
  fs.appendFileSync(path.join(P, '.claude', 'ops', 'pm-ops.project.md'), '\n- 부록 한 줄\n');
  gen('gen-skill.js');
  assert.deepStrictEqual(lock.drift(P), [], 'gen-skill 뒤 어긋남 없음');

  // 3. --out으로 다른 곳에 만든 것은 lock을 건드리지 않음
  const snap = JSON.stringify(lock.readLock(P));
  gen('gen-agents.js', '--out', path.join(tmp, 'elsewhere'));
  assert.strictEqual(JSON.stringify(lock.readLock(P)), snap, '--out은 lock 그대로');

  // 4. 사람이 생성물을 직접 고친 것만 어긋남, 지운 것은 missing
  fs.appendFileSync(path.join(P, '.claude', 'agents', 'LG-commit.md'), '손으로 고침\n');
  fs.unlinkSync(path.join(P, '.claude', 'agents', 'LG-backend1.md'));
  assert.deepStrictEqual(lock.drift(P).sort((a, b) => a.file.localeCompare(b.file)), [
    { file: '.claude/agents/LG-backend1.md', state: 'missing' },
    { file: '.claude/agents/LG-commit.md', state: 'changed' },
  ]);

  // 5. lock이 없는 프로젝트는 생성기가 lock을 만들지 않음
  fs.unlinkSync(path.join(P, lock.LOCK));
  gen('gen-agents.js');
  assert.ok(!fs.existsSync(path.join(P, lock.LOCK)), 'lock 없으면 그대로 없음');
  console.log('wy-ops lockgen 검사 통과');
} finally {
  rmTree(tmp);
}
