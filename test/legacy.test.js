// cleanup-legacy(U-13) 검사: 옛 승인 위치·옛 설치본만 목록에 오르고, 프로젝트별 승인 폴더는 절대 지우지 않는다. 임시 홈에서만.
//   node tools/wy-ops/test/legacy.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const { rmTree } = require('../lib/fsx');
const path = require('path');
const legacy = require('../lib/legacy');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-legacy-'));
const write = (p, text = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const approvals = path.join(home, '.claude', 'wy-approvals');
const oldInstall = path.join(home, '.wy-tools', 'vscode-dashboard');
const env = {}; // 실제 WY_APPROVALS_DIR을 따라가지 않게
const opts = (extra = {}) => ({ env, ...extra });

try {
  // 옛 승인 위치(바탕 바로 아래)와 프로젝트별 폴더(같은 이름의 하위 폴더 포함)
  write(path.join(approvals, 'requests', 'old-1.json'));
  write(path.join(approvals, 'decisions', 'old-1.json'));
  write(path.join(approvals, 'used', 'old-1.json'));
  write(path.join(approvals, 'decisions.log'), '{"id":"a"}\n{"id":"b"}\n');
  for (const f of ['requests/r.json', 'decisions/d.json', 'used/u.json', 'sessions/s.json', 'decisions.log', 'message-blocks.log']) write(path.join(approvals, 'erp-project', f));
  write(path.join(approvals, 'other-ns', 'requests', 'r.json'));
  write(path.join(oldInstall, 'extension.js'));
  write(path.join(oldInstall, 'hooks', 'wy-approval-guard.js'));
  write(path.join(home, '.wy-tools', 'wy-ops', 'current', 'deployed.json'), '{}');

  // 1. 목록: 옛 위치 4개 + 옛 설치본, 프로젝트별 폴더·새 설치본은 없음
  const items = legacy.list(home, opts());
  const rel = (p) => path.relative(home, p).replace(/\\/g, '/');
  assert.deepStrictEqual(items.map((i) => rel(i.path)).sort(), [
    '.claude/wy-approvals/decisions', '.claude/wy-approvals/decisions.log', '.claude/wy-approvals/requests', '.claude/wy-approvals/used', '.wy-tools/vscode-dashboard',
  ], '정리 대상');
  assert.ok(items.every((i) => !rel(i.path).includes('erp-project') && !rel(i.path).includes('other-ns') && !rel(i.path).includes('wy-ops')), '프로젝트 폴더·새 설치본은 대상 아님');
  assert.strictEqual(items.find((i) => rel(i.path) === '.wy-tools/vscode-dashboard').count, 2, '파일 수');
  assert.ok(items.find((i) => rel(i.path).endsWith('decisions.log')).what.includes('2줄'), '로그 줄 수');

  // 2. 훅이 옛 설치본을 아직 가리키면 inUse, remove가 거부
  const settings = path.join(home, 'settings.local.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: `node "${path.join(oldInstall, 'hooks', 'wy-approval-guard.js').replace(/\\/g, '/')}"` }] }] } }));
  const busy = legacy.list(home, opts({ settingsFiles: [settings] })).find((i) => rel(i.path) === '.wy-tools/vscode-dashboard');
  assert.strictEqual(busy.inUse, true, '훅이 가리킴');
  const refused = legacy.remove([busy], home, opts({ settingsFiles: [settings] }));
  assert.deepStrictEqual([refused[0].removed, /훅/.test(refused[0].reason)], [false, true], '사용 중이면 지우지 않음');
  assert.ok(fs.existsSync(oldInstall), '옛 설치본 그대로');

  // 3. 목록에 없는 경로·프로젝트별 폴더를 넘겨도 지우지 않는다
  const sneaky = legacy.remove([path.join(approvals, 'erp-project'), path.join(approvals, 'erp-project', 'decisions'), approvals, home, 'C:/Windows'], home, opts());
  assert.ok(sneaky.every((r) => r.removed === false), '목록 밖은 거부');
  assert.ok(fs.existsSync(path.join(approvals, 'erp-project', 'decisions', 'd.json')), '프로젝트 결정 그대로');

  // 4. 받은 것만 지운다: 옛 승인 위치 3개만 넘김 → 그것만 사라지고 나머지는 그대로
  const pick = items.filter((i) => ['requests', 'decisions', 'decisions.log'].includes(path.basename(i.path)));
  const done = legacy.remove(pick, home, opts());
  assert.ok(done.every((r) => r.removed), '지움');
  for (const n of ['requests', 'decisions', 'decisions.log']) assert.ok(!fs.existsSync(path.join(approvals, n)), `${n} 지워짐`);
  assert.ok(fs.existsSync(path.join(approvals, 'used')), '넘기지 않은 used는 그대로');
  for (const f of ['requests/r.json', 'decisions/d.json', 'used/u.json', 'sessions/s.json', 'decisions.log', 'message-blocks.log']) {
    assert.ok(fs.existsSync(path.join(approvals, 'erp-project', f)), `프로젝트별 ${f} 그대로`);
  }
  assert.ok(fs.existsSync(path.join(approvals, 'other-ns', 'requests', 'r.json')), '다른 namespace 그대로');

  // 5. 훅을 옮긴 뒤에는 옛 설치본도 지울 수 있다, 새 설치본은 그대로
  fs.writeFileSync(settings, JSON.stringify({ hooks: {} }));
  const rest = legacy.list(home, opts({ settingsFiles: [settings] }));
  const r2 = legacy.remove(rest, home, opts({ settingsFiles: [settings] }));
  assert.ok(r2.every((r) => r.removed), '남은 것 지움');
  assert.ok(!fs.existsSync(oldInstall) && fs.existsSync(path.join(home, '.wy-tools', 'wy-ops', 'current', 'deployed.json')), '옛 설치본만 지움');
  assert.deepStrictEqual(legacy.list(home, opts()), [], '정리 끝');

  // 6. 한글·공백 홈: 따옴표로 감싼 훅 명령도 옛 설치본을 가리키는 것으로 읽고, 확실히 읽지 못하거나 settings가 깨졌으면 사용 중으로 남긴다
  {
    const home2 = path.join(home, '사용자 홈 2');
    const old2 = path.join(home2, '.wy-tools', 'vscode-dashboard');
    write(path.join(old2, 'hooks', 'wy-approval-guard.js'));
    const s2 = path.join(home2, 'settings.local.json');
    const guard = path.join(old2, 'hooks', 'wy-approval-guard.js').replace(/\\/g, '/');
    const item = (command, raw) => {
      fs.writeFileSync(s2, raw !== undefined ? raw : JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command }] }] } }));
      return legacy.list(home2, opts({ settingsFiles: [s2] })).find((i) => i.path === old2);
    };
    assert.strictEqual(item(`node "${guard}"`).inUse, true, '따옴표 경로를 읽어 사용 중');
    const unquoted = item(`node ${guard}`);
    assert.ok(unquoted.inUse && unquoted.what.includes('확실히 읽지 못해'), '판단 불가는 사용 중');
    assert.strictEqual(item(null, '{ 깨진 settings').inUse, true, '읽지 못한 settings도 사용 중');
    assert.ok(legacy.remove([item(`node ${guard}`)], home2, opts({ settingsFiles: [s2] }))[0].removed === false && fs.existsSync(old2), '판단 불가면 지우지 않음');
    assert.strictEqual(item(`node "C:/elsewhere/hooks/wy-approval-guard.js"`).inUse, false, '다른 곳을 확실히 가리키면 사용 안 함');
  }

  console.log('legacy 검사 통과');
} finally {
  rmTree(home);
}
