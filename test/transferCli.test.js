// install.js export·import 명령 검사(디스패처 연결): 임시 홈 A에서 내보내고 임시 홈 B·다른 프로젝트 경로로 들여온다
//   node tools/wy-ops/test/transferCli.test.js
// transfer.js 자체 규칙(비밀값·경로 바꾸기·used 표시)은 transfer.test.js가 본다. 여기서는 명령·확인·출력만 본다
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rmTree } = require('../lib/fsx');
const { projectKey } = require('../lib/transfer');

const INSTALL = path.join(__dirname, '..', 'lib', 'install.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-xfer-cli-'));
const put = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const cli = (home, args, input = '') => {
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  delete env.WY_APPROVALS_DIR;
  const r = spawnSync(process.execPath, [INSTALL, ...args], { env, input, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

try {
  const homeA = path.join(tmp, 'a');
  const homeB = path.join(tmp, 'b');
  const projA = path.join(tmp, 'pa');
  const projB = path.join(tmp, 'pb');
  const ops = JSON.stringify({ commitRole: 'AB-commit', approvals: { namespace: 'demo' } });
  put(path.join(projA, '.claude', 'wy-ops.json'), ops);
  put(path.join(projB, '.claude', 'wy-ops.json'), ops);
  put(path.join(homeA, '.claude', 'projects', projectKey(projA), 'memory', 'MEMORY.md'), '- 메모 하나\n');
  put(path.join(homeA, '.claude', 'wy-approvals', 'demo', 'decisions', 'c1.json'), JSON.stringify({ id: 'c1', decision: 'approved' }));
  const zip = path.join(tmp, 'out', 'move.zip');

  const ex = cli(homeA, ['export', '--project', projA, '--out', zip]);
  assert.strictEqual(ex.status, 0, ex.out);
  assert.ok(fs.existsSync(zip), '묶음 파일');
  assert.ok(ex.out.includes('개인 USB나 드라이브로만 옮기고, 옮긴 뒤 지우세요'), '안내 문구');
  assert.ok(ex.out.includes('이름표 없는 비밀값'), '비밀값 검사 한계 문구');
  assert.ok(ex.out.includes('지금 시점의 사본') && ex.out.includes('진행 상태를 저장'), '한 시점 사본·세션 저장 안내');
  assert.ok(!ex.out.includes('[주의]'), 'git 저장소가 아니면 git 경고 없음');

  // 이전 전 점검: 커밋 안 된 변경이 있으면 경고하고 확인(n이면 묶지 않음, --yes면 묶음)
  {
    const projG = path.join(tmp, 'pg');
    put(path.join(projG, '.claude', 'wy-ops.json'), ops);
    assert.strictEqual(spawnSync('git', ['init', '-q', projG]).status, 0);
    const zipG = path.join(tmp, 'out', 'g.zip');
    const no = cli(homeA, ['export', '--project', projG, '--out', zipG], 'n\n');
    assert.ok(no.out.includes('[주의] 커밋 안 된 변경') && no.out.includes('묶지 않았습니다') && !fs.existsSync(zipG), no.out);
    const yes = cli(homeA, ['export', '--project', projG, '--out', zipG, '--yes']);
    assert.ok(yes.status === 0 && fs.existsSync(zipG), yes.out);
  }

  const dry = cli(homeB, ['import', zip, '--project', projB, '--dry-run']);
  assert.strictEqual(dry.status, 0, dry.out);
  assert.ok(!fs.existsSync(path.join(homeB, '.claude', 'projects', projectKey(projB), 'memory', 'MEMORY.md')), '--dry-run은 쓰지 않음');

  const im = cli(homeB, ['import', zip, '--project', projB]);
  assert.strictEqual(im.status, 0, im.out);
  assert.strictEqual(fs.readFileSync(path.join(homeB, '.claude', 'projects', projectKey(projB), 'memory', 'MEMORY.md'), 'utf8'), '- 메모 하나\n', '메모리를 새 프로젝트 키로');
  assert.ok(fs.existsSync(path.join(homeB, '.claude', 'wy-approvals', 'demo', 'used', 'c1.json')), '들여온 결정은 used 표시');
  assert.ok(im.out.includes('새 PC에서 다시 할 일') && im.out.includes('MCP 서버 토큰') && im.out.includes('gh auth login') && im.out.includes('비밀값 폴더'), '새 PC 할 일 목록');
  assert.ok(/'사용됨'으로 표시/.test(im.out), '사용됨 안내');

  // 덮어쓸 파일이 있으면 확인을 묻고, 아니오면 그대로 둔다
  put(path.join(homeB, '.claude', 'projects', projectKey(projB), 'memory', 'MEMORY.md'), '- 바꾼 메모\n');
  const no = cli(homeB, ['import', zip, '--project', projB], 'n\n');
  assert.ok(no.out.includes('덮어씀') && no.out.includes('들여오지 않았습니다'), no.out);
  assert.strictEqual(fs.readFileSync(path.join(homeB, '.claude', 'projects', projectKey(projB), 'memory', 'MEMORY.md'), 'utf8'), '- 바꾼 메모\n', '거절하면 그대로');
  const yes = cli(homeB, ['import', zip, '--project', projB, '--yes']);
  assert.ok(/백업: /.test(yes.out), `백업 위치 출력\n${yes.out}`);
  assert.strictEqual(fs.readFileSync(path.join(homeB, '.claude', 'projects', projectKey(projB), 'memory', 'MEMORY.md'), 'utf8'), '- 메모 하나\n', '--yes면 덮어씀');

  const bad = cli(homeB, ['import']);
  assert.notStrictEqual(bad.status, 0, 'zip 없으면 실패');
  console.log('transferCli 검사 통과');
} finally {
  rmTree(tmp);
}
