// tools/wy-ops/lib 검사: settings 병합·lock 해시·할 일 카드
//   node tools/wy-ops/test/lib.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmTree } = require('../lib/fsx');
const settings = require('../lib/settings');
const lock = require('../lib/lock');
const { writeTodo } = require('../lib/todo');
// 승인 센터 저장소: 할 일 카드가 형식 오류로 보이지 않는지 확인용
const store = require('../vscode/approvalStore');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-lib-'));
const NEW = 'C:/Users/pc2/.wy-tools/wy-ops/current/vscode/hooks';
const OLD = 'C:/Users/pc2/.wy-tools/vscode-dashboard/hooks';
try {
  // 1. settings: 빈 파일 → deny 9줄 + 훅 6개
  {
    const { next, changes } = settings.plan({}, NEW);
    assert.strictEqual(changes.filter((c) => c.type === 'deny-add').length, 9);
    assert.strictEqual(changes.filter((c) => c.type === 'hook-add').length, 6);
    assert.deepStrictEqual(next.hooks.PreToolUse.map((g) => g.matcher), ['Bash|PowerShell', 'SendMessage']);
    assert.strictEqual(next.hooks.PermissionRequest[0].hooks[0].timeout, 960);
    assert.ok(JSON.stringify(next).includes(`${NEW}/wy-session-start.js`));
    // 두 번째는 바꿀 것 없음(여러 번 실행해도 같음)
    assert.strictEqual(settings.plan(next, NEW).changes.length, 0, '다시 하면 바꿀 것 없음');
  }
  // 2. settings: 지금 이 PC 모양(옛 설치본 경로, allow, 다른 키, 옛 deny) → 경로만 바꾸고 나머지 보존
  {
    const cur = {
      permissions: { allow: ['WebSearch'], deny: ['Edit(~/.claude/wy-approvals/config.json)', 'Edit(~/.wy-tools/**)'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node', args: [`${OLD}/wy-approval-guard.js`], timeout: 10 }] },
          { matcher: 'Write', hooks: [{ type: 'command', command: 'node my-own-hook.js' }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: `node "${OLD}/wy-session-start.js"`, timeout: 10 }] }],
      },
      model: 'opus',
    };
    const { next, changes } = settings.plan(cur, NEW);
    assert.deepStrictEqual(next.permissions.allow, ['WebSearch'], 'allow는 그대로');
    assert.strictEqual(next.model, 'opus', '다른 키 보존');
    assert.ok(next.permissions.deny.includes('Edit(~/.claude/wy-approvals/config.json)'), '옛 deny 줄 보존');
    assert.strictEqual(next.permissions.deny.filter((d) => d === 'Edit(~/.wy-tools/**)').length, 1, '있는 deny는 다시 넣지 않음');
    const updates = changes.filter((c) => c.type === 'hook-update');
    assert.strictEqual(updates.length, 2, '옛 경로 훅 2개를 새 경로로');
    assert.strictEqual(next.hooks.PreToolUse.length, 3, '가드는 교체, 남의 훅 유지, 메시지 가드 추가');
    assert.strictEqual(next.hooks.PreToolUse[1].hooks[0].command, 'node my-own-hook.js', '남의 훅은 건드리지 않음');
    assert.ok(!JSON.stringify(next).includes('vscode-dashboard/hooks'), '옛 경로가 남지 않음');
    assert.ok(updates.every((c) => settings.describe(c).startsWith('~ 훅')));
  }
  // 3. settings apply: bak을 남기고 쓰고, BOM 파일도 읽는다
  {
    const f = path.join(tmp, 'proj', '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '\ufeff' + JSON.stringify({ permissions: { allow: ['WebSearch'] } }));
    const { next } = settings.plan(settings.readSettings(f), NEW);
    const bak = settings.apply(f, next, new Date('2026-10-07T01:02:03Z'));
    assert.ok(bak.endsWith('.bak-20261007T010203') && fs.existsSync(bak), '백업 이름');
    assert.deepStrictEqual(settings.readSettings(f).permissions.allow, ['WebSearch']);
    assert.ok(!fs.readdirSync(path.dirname(f)).some((x) => x.endsWith('.tmp')), '임시 파일 남지 않음');
  }
  // 4. lock: create → same → update(lock과 같음) → modified(사람이 고침) → unmanaged(lock에 없던 기존 파일)
  {
    const root = path.join(tmp, 'lockproj');
    fs.mkdirSync(root);
    let l = lock.readLock(root);
    const d1 = lock.decide(root, l, '.claude/agents/A.md', 'v1\n');
    assert.strictEqual(d1.action, 'create');
    l = lock.writePlanned(root, l, [{ ...d1, content: 'v1\n' }], '0.6.0');
    assert.strictEqual(lock.decide(root, l, '.claude/agents/A.md', 'v1\n').action, 'same');
    fs.writeFileSync(path.join(root, '.claude/agents/A.md'), 'v1\r\n');
    assert.strictEqual(lock.decide(root, l, '.claude/agents/A.md', 'v1\n').action, 'same', 'CRLF만 다르면 같음');
    const d2 = lock.decide(root, l, '.claude/agents/A.md', 'v2\n');
    assert.strictEqual(d2.action, 'update', '손대지 않은 생성 파일은 덮어도 됨');
    l = lock.writePlanned(root, l, [{ ...d2, content: 'v2\n' }]);
    assert.strictEqual(fs.readFileSync(path.join(root, '.claude/agents/A.md'), 'utf8'), 'v2\n');
    fs.writeFileSync(path.join(root, '.claude/agents/A.md'), 'v2 손으로 고침\n');
    const d3 = lock.decide(root, l, '.claude/agents/A.md', 'v3\n');
    assert.strictEqual(d3.action, 'modified', '사람이 고친 파일은 덮지 않음');
    l = lock.writePlanned(root, l, [{ ...d3, content: 'v3\n' }]);
    assert.strictEqual(fs.readFileSync(path.join(root, '.claude/agents/A.md'), 'utf8'), 'v2 손으로 고침\n', 'modified는 쓰지 않음');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# 내 프로젝트\n');
    assert.strictEqual(lock.decide(root, l, 'CLAUDE.md', '# 템플릿\n').action, 'unmanaged', 'lock에 없는 기존 파일은 덮지 않음');
    assert.strictEqual(l.version, '0.6.0');
  }
  // 5. 할 일 카드: B2-2 형식으로 쓰고, 다시 쓰지 않고, 결정 파일은 만들지 않음
  {
    const root = path.join(tmp, 'approvals');
    const item = { key: 'Login GitHub', title: 'GitHub 로그인', what: 'gh auth login', why: 'WY-commit이 푸시·PR을 하려면 필요', steps: ['터미널에서 gh auth login'], check: 'gh auth status가 Logged in' };
    const r1 = writeTodo(root, item);
    assert.deepStrictEqual(r1, { id: 'setup-login-github', written: true });
    const req = store.readRequest(path.join(root, 'requests', 'setup-login-github.json'), 'setup-login-github');
    assert.ok(!req.broken, req.broken);
    assert.deepStrictEqual([req.kind, req.steps, req.check], ['todo', ['터미널에서 gh auth login'], 'gh auth status가 Logged in']);
    assert.ok(req.onClick, '기본 onClick');
    assert.strictEqual(writeTodo(root, { ...item, what: '바뀜' }).written, false, '같은 id는 다시 쓰지 않음');
    assert.ok(!fs.existsSync(path.join(root, 'decisions')) && !fs.existsSync(path.join(root, 'used')), '결정·사용 폴더를 만들지 않음');
    assert.throws(() => writeTodo(root, { key: 'x', title: 't', what: '', why: 'y' }), /what/);
  }
  console.log('wy-ops lib 검사 통과');
} finally {
  rmTree(tmp);
}
