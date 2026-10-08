#!/usr/bin/env node
// 메시지 대상 확인 훅(PreToolUse, matcher SendMessage). 운영 도구 구현 계획 B2-6
//   대상 이름의 세션이 모두 끝나 있으면(done·stopped·failed, 살아 있는 같은 이름 없음) 보내기를 거부한다.
//   2026-10-07 '대기 중 종료 → 메시지 유실'이 두 번 있었다. 보내는 쪽이 바로 알게 한다.
// 살아 있거나 대화형이면 통과. 목록에 없는 이름(main·하위 에이전트·팀원)과 claude agents를 못 읽을 때도 통과(평소 흐름).
// 보안 장치가 아니라 편의 장치라 오류는 통과시킨다(가드 훅과 반대).
// 거부할 때마다 승인 폴더의 message-blocks.log에 한 줄({at, from, fromSessionId, to, toSessionId, toState})을 덧붙인다.
//   세션 현황의 '꺼진 뒤 메시지 옴' 경고가 읽는다(agentsReader). 메시지 본문은 남기지 않는다. 1MB를 넘으면 앞 절반을 버린다.
const fs = require('fs');
const path = require('path');
const { readAgents, isReachable } = require('../agentsReader');

const LOG_NAME = 'message-blocks.log';
const LOG_MAX_BYTES = 1024 * 1024;

// "XX-qa [3fa9c1]" → "XX-qa"
const nameOf = (to) => String(to || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();

function check(list, to, pmRole = null) {
  const name = nameOf(to);
  if (!name || name === 'main') return null;
  const same = (list || []).filter((s) => s && s.name === name);
  if (!same.length || isReachable(list, name)) return null;
  const latest = same.reduce((a, b) => ((b.startedAt || 0) > (a.startedAt || 0) ? b : a));
  const state = latest.state || '상태 미상';
  return {
    decision: 'deny',
    reason: `대상 세션 ${name}이 종료됨(${state}) — 메시지가 전달되지 않습니다. ${pmRole || 'pm 세션'}에 알리거나 session.ps1 start ${name}으로 재시작하세요.`,
    to: name,
    toSessionId: latest.sessionId || null,
    toState: latest.state || null,
  };
}

// 거부 기록 한 줄을 덧붙인다. 파일이 maxBytes를 넘으면 뒤 절반(줄 단위)만 남긴다
function recordBlock(root, entry, maxBytes = LOG_MAX_BYTES) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, LOG_NAME);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  if (fs.statSync(file).size <= maxBytes) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
  fs.renameSync(tmp, file);
}

function blockEntry(list, input, result, now = new Date()) {
  const me = (list || []).find((s) => s && s.sessionId && s.sessionId === input.session_id);
  return {
    at: now.toISOString(),
    from: (me && me.name) || null,
    fromSessionId: input.session_id || null,
    to: result.to,
    toSessionId: result.toSessionId,
    toState: result.toState,
  };
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(raw);
      const list = await readAgents();
      let pmRole = null;
      try {
        const ops = require('../opsConfig').loadOpsConfig(input.cwd || process.cwd());
        pmRole = ops && ops.pmRole;
      } catch {
        // 설정을 못 읽으면 일반 문구
      }
      const result = check(list, input.tool_input && input.tool_input.to, pmRole);
      if (result) {
        try {
          const store = require('../approvalStore');
          recordBlock(store.rootFor(input.cwd || process.cwd()), blockEntry(list, input, result));
        } catch {
          // 기록은 편의 기능이라 실패해도 거부는 그대로
        }
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
        process.stderr.write(result.reason + '\n');
        process.exit(2);
      }
    } catch {
      // 목록을 못 읽으면 평소대로 보낸다
    }
    process.exit(0);
  });
}

module.exports = { check, nameOf, recordBlock, blockEntry, LOG_NAME };
