#!/usr/bin/env node
// SessionStart 훅: 세션이 어떤 역할(--agent)로 떴는지 승인 폴더의 sessions/<sessionId>.json에 남긴다(OPS-06 2·4).
// 세션 현황(역할 누락 배지)과 승인 센터(커밋 세션 경고)가 읽는다. 형식: 운영 도구 구현 계획 2.2
//   { sessionId, agentType, startedAt, cwd, source }
// 기록용이라 어떤 경우에도 세션 시작을 막지 않는다(항상 종료 코드 0).
const fs = require('fs');
const path = require('path');
const store = require('../approvalStore');

function record(input, now = new Date()) {
  const id = String(input.session_id || '');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) return null;
  const root = store.rootFor(input.cwd || process.cwd());
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const out = {
    sessionId: id,
    agentType: input.agent_type || null,
    startedAt: now.toISOString(),
    cwd: input.cwd || null,
    source: input.source || null, // startup·resume·clear·compact
  };
  store.writeJsonAtomic(path.join(dir, `${id}.json`), out);
  return out;
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    try {
      record(JSON.parse(raw));
    } catch {
      // 기록 실패는 무시한다
    }
    process.exit(0);
  });
}

module.exports = { record };
