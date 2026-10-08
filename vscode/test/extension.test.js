// 확장 진입점 기본 검사(B2-0): 세 화면 모듈이 모두 등록되고, 명령·직렬화기·뷰가 package.json과 맞는다.
//   node tools/wy-ops/vscode/test/extension.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.WY_APPROVALS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-ext-'));
const { install, EXT } = require('./fakeVscode');

const fake = install({ workspace: 'C:/projects/erp-project' });
try {
  require(path.join(EXT, 'extension.js')).activate(fake.context);
  assert.deepStrictEqual(fake.messages.filter((m) => m[0] === 'error'), [], '시작 오류 없음');

  // package.json에 적은 명령은 모두 등록돼 있어야 한다
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  for (const c of pkg.contributes.commands) assert.ok(fake.commands[c.command], `명령 등록: ${c.command}`);
  for (const e of pkg.activationEvents.filter((x) => x.startsWith('onWebviewPanel:'))) assert.ok(fake.serializers[e.split(':')[1]], `직렬화기: ${e}`);
  for (const v of Object.values(pkg.contributes.views).flat()) assert.ok(fake.viewProviders[v.id], `뷰: ${v.id}`);

  // 세션 현황 뷰가 뜨고 역할 목록을 보낸다
  const view = fake.resolveView('wyOps.sessions');
  view.visible = false; // 폴링(claude agents 실행)은 하지 않는다
  view.send({ type: 'ready' });
  const roles = view.posts.find((m) => m.type === 'roles');
  assert.ok(roles && roles.data.includes('WY-commit'), '세션 현황 역할 목록');

  // 세션 현황에서 보기: 뷰에 reveal 메시지
  return (async () => {
    await fake.commands['wyOps.revealSession']('abc-123');
    assert.ok(fake.executed.some((e) => e[0] === 'wyOps.sessions.focus'), '뷰 열기');
    assert.ok(view.posts.some((m) => m.type === 'reveal' && m.sessionId === 'abc-123'), 'reveal 전달');

    // 승인 센터: { id }로 열면 ready 뒤 select
    fake.commands['wyApprovals.open']({ id: 'perm-abc' });
    const ap = fake.panels.find((p) => p.type === 'wyApprovals');
    ap.send({ type: 'ready' });
    assert.ok(ap.posts.some((m) => m.type === 'state'), '승인 센터 상태');
    assert.ok(ap.posts.some((m) => m.type === 'select' && m.id === 'perm-abc'), '카드 고르기 전달');

    // 활동 탭: 열리고 빈 상태를 보낸다
    fake.commands['wyActivity.open']();
    const act = fake.panels.find((p) => p.type === 'wyActivity');
    assert.ok(act && !/{{\w+}}/.test(act.webview.html), '활동 탭 HTML');
    act.send({ type: 'ready' });
    assert.ok(act.posts.some((m) => m.type === 'state'), '활동 탭 상태');

    // 직렬화기로 되살리기
    const p2 = fake.makePanel('wyActivity', 'x');
    await fake.serializers.wyActivity.deserializeWebviewPanel(p2);
    assert.ok(p2.webview.html.includes('WY 활동'), '활동 탭 복원');
    console.log('extension 기본 검사 통과');
  })();
} finally {
  setTimeout(() => {
    fake.uninstall();
    fs.rmSync(process.env.WY_APPROVALS_DIR, { recursive: true, force: true });
  }, 0);
}
