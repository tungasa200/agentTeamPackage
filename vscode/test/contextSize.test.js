// 대화 크기(contextSize.js)·대화 크기 훅(wy-context-size.js)·세션 현황의 토큰 칸(토큰 절감 2차, 2026-10-07)
//   node tools/wy-ops/vscode/test/contextSize.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-ctx-'));
process.env.WY_APPROVALS_DIR = path.join(tmp, 'approvals'); // approvalStore가 require 때 읽는다
const { readContextTokens, transcriptFile, thresholds } = require('../contextSize');
const hook = require('../hooks/wy-context-size');
const { readSessionStatus } = require('../agentsReader');

const line = (o) => JSON.stringify(o);
const assistant = (inp, read, create, extra) => line({ type: 'assistant', message: { usage: { input_tokens: inp, cache_read_input_tokens: read, cache_creation_input_tokens: create, output_tokens: 9 } }, ...extra });

(async () => {
  try {
    // 1. 마지막 assistant usage 합. 뒤의 user 줄·sidechain·합성(0) 응답은 건너뛴다
    const t = path.join(tmp, 't.jsonl');
    fs.writeFileSync(t, [assistant(1, 1000, 10), assistant(2, 210000, 500), assistant(5, 9, 9, { isSidechain: true }), assistant(0, 0, 0), line({ type: 'user', message: { content: 'assistant' } })].join('\n') + '\n');
    assert.strictEqual(readContextTokens(t), 210502);
    assert.strictEqual(readContextTokens(path.join(tmp, 'none.jsonl')), null, '없는 파일은 null');
    // 끝 1MB 밖의 잘린 줄은 버리고 그 뒤 응답을 읽는다
    const big = path.join(tmp, 'big.jsonl');
    fs.writeFileSync(big, assistant(1, 1, 1) + '\n' + line({ type: 'user', pad: 'x'.repeat(1100 * 1024) }) + '\n' + assistant(3, 4, 5) + '\n');
    assert.strictEqual(readContextTokens(big), 12);

    // 2. 기준값: 설정이 없으면 15만·20만
    assert.deepStrictEqual(thresholds(null), { contextTokens: 150000, notifyTokens: 200000 });
    assert.deepStrictEqual(thresholds({ rotation: { contextTokens: 1000 } }), { contextTokens: 1000, notifyTokens: 200000 });
    assert.ok(transcriptFile('C:\\projects\\erp-project', 'abc', 'H').endsWith(path.join('projects', 'C--projects-erp-project', 'abc.jsonl')));

    // 3. 훅: 프로젝트 설정(roles)과 가짜 claude agents 목록
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.claude', 'wy-ops.json'), JSON.stringify({ pmRole: 'WY-pm', roles: [{ name: 'WY-qa', agent: true }, { name: 'WY-pm', agent: false }] }));
    const sid = '11111111-2222-3333-4444-555555555555';
    const input = { session_id: sid, transcript_path: t, cwd: proj, hook_event_name: 'Stop', stop_hook_active: false };
    const agents = (name) => async () => [{ name, sessionId: sid }];
    const marker = hook.markerFile(require('../approvalStore').rootFor(proj), sid);

    const msg = await hook.check(input, { listAgents: agents('WY-qa') });
    assert.ok(msg && msg.includes('WY-qa') && msg.includes('211k') && msg.includes('세션 교체 요청') && msg.includes('WY-pm'), msg);
    assert.ok(fs.existsSync(marker), '표시 파일');
    assert.strictEqual(await hook.check(input, { listAgents: agents('WY-qa') }), null, '세션당 한 번');
    fs.rmSync(marker);
    assert.strictEqual(await hook.check({ ...input, stop_hook_active: true }, { listAgents: agents('WY-qa') }), null, '훅이 이어 간 턴에는 다시 막지 않음');
    assert.strictEqual(await hook.check(input, { listAgents: agents('WY-pm') }), null, 'pm·역할 아닌 세션은 알리지 않음');
    assert.ok(fs.existsSync(marker), '역할이 아니어도 표시를 남겨 다시 확인하지 않음');
    fs.rmSync(marker);
    await assert.rejects(hook.check(input, { listAgents: async () => { throw new Error('x'); } }));
    assert.ok(!fs.existsSync(marker), '목록을 못 읽으면 표시를 남기지 않음(다음 턴에 다시)');
    fs.writeFileSync(path.join(proj, '.claude', 'wy-ops.local.json'), JSON.stringify({ rotation: { notifyTokens: 300000 } }));
    assert.strictEqual(await hook.check(input, { listAgents: agents('WY-qa') }), null, '기준 미만');

    // 4. 세션 현황: contextTokens·rotate
    const home = path.join(tmp, 'home');
    const tdir = path.dirname(transcriptFile(proj, sid, home));
    fs.mkdirSync(tdir, { recursive: true });
    fs.copyFileSync(t, transcriptFile(proj, sid, home));
    const ops = { root: proj, roles: [] };
    const rows = await readSessionStatus({ root: path.join(tmp, 'approvals'), ops, list: [{ name: 'WY-qa', kind: 'background', sessionId: sid, state: 'working' }, { name: 'WY-x', kind: 'background', sessionId: 'nope', state: 'working' }], home });
    assert.deepStrictEqual(rows.map((r) => [r.name, r.contextTokens, r.rotate]), [['WY-qa', 210502, true], ['WY-x', null, false]]);
    console.log('contextSize.test.js: 통과');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
