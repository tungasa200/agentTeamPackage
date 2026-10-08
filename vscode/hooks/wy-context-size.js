#!/usr/bin/env node
// Stop 훅: 역할 세션의 대화가 rotation.notifyTokens(기본 20만)를 넘으면 한 번만 "이 단계까지 마치고 보고한 뒤 세션 교체 요청"을 알린다.
//   매 턴 대화 전체를 다시 읽으므로 비용 ≈ 턴 수 × 대화 크기(토큰 절감 2차, 사용자 결정 2026-10-07).
//   세션당 한 번: 승인 폴더 sessions/<sessionId>.ctx-notified 표시 파일. 역할 세션이 아니어도 표시를 남겨 다시 확인하지 않는다.
//   역할 판단: claude agents 목록에서 이 세션의 이름이 wy-ops.json roles(agent:true)인지. 넘은 뒤 한 번만 부른다.
// 어떤 오류에도 세션을 막지 않는다(알릴 때만 decision:block으로 한 턴 더 이어 가게 하고, 그 밖에는 출력 없이 종료 코드 0).
const fs = require('fs');
const path = require('path');
const store = require('../approvalStore');
const { loadOpsConfig } = require('../opsConfig');
const { readContextTokens, thresholds } = require('../contextSize');

const markerFile = (root, id) => path.join(root, 'sessions', `${id}.ctx-notified`);

function message(name, tokens, pmRole) {
  const k = Math.round(tokens / 1000);
  return `[컨텍스트 크기 알림] ${name} 세션의 컨텍스트가 약 ${k}k 토큰입니다. 매 턴 컨텍스트 전체를 다시 읽어 비용이 커집니다. ` +
    `새 작업을 시작하지 말고, 지금 단계까지만 마친 뒤 ${pmRole}에 [완료](끝났으면) 또는 진행 상태(미커밋 파일·남은 일)를 보고하고 ` +
    `같은 메시지에 "세션 교체 요청"을 적으세요. 이 알림은 이 세션에 한 번만 옵니다.`;
}

// 알릴 문구를 돌려준다(알릴 것이 없으면 null). listAgents는 시험에서 바꿔 끼운다
async function check(input, { listAgents } = {}) {
  if (!input || input.stop_hook_active) return null;
  const id = String(input.session_id || '');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id) || !input.transcript_path) return null;
  const ops = loadOpsConfig(input.cwd || process.cwd());
  const { notifyTokens } = thresholds(ops);
  const tokens = readContextTokens(input.transcript_path);
  if (!tokens || tokens < notifyTokens) return null;
  const root = store.rootFor(input.cwd || process.cwd());
  const marker = markerFile(root, id);
  if (fs.existsSync(marker)) return null;
  // 목록을 못 읽으면(오류) 표시를 남기지 않고 다음 턴에 다시 본다
  const list = await (listAgents || require('../agentsReader').readAgents)();
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${new Date().toISOString()} ${tokens}\n`, 'utf8');
  const me = (list || []).find((s) => s && s.sessionId === id);
  const role = me && ops && Array.isArray(ops.roles) && ops.roles.find((r) => r && r.name === me.name && r.agent !== false);
  if (!role) return null;
  return message(role.name, tokens, (ops && ops.pmRole) || 'pm');
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', async () => {
    try {
      const reason = await check(JSON.parse(raw));
      if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    } catch {
      // 알림 실패는 무시한다
    }
    process.exit(0);
  });
}

module.exports = { check, message, markerFile };
