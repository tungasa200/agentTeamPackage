#!/usr/bin/env node
// 권한 카드 훅(OPS-02 ①, 운영 도구 구현 계획 B2-4)
//   PermissionRequest: 확인 창이 뜰 상황이면 승인 센터에 권한 카드를 올리고, 결정을 기다려 허용·거부를 돌려준다.
//   PermissionDenied: 분류기가 막은 명령을 할 일 카드(직접 실행)로 올린다. 이미 막힌 결정은 뒤집지 않는다.
// 카드는 백그라운드 세션(claude agents kind=background)만. 대화형·종류를 모르는 세션은 결정 없이 끝내 평소 확인 창으로.
// 2026-10-07 실험: 훅 입력에 tool_use_id가 없다 → 결정 키는 sha1(session_id·tool_name·tool_input) 앞 16자.
// 같은 명령을 다시 요청하면 앞 카드가 이미 결정·사용됐을 때 -2, -3…을 붙여 새 카드로 만든다.
// 허용은 그 한 번만(updatedPermissions 안 씀). 15분 안에 결정이 없으면 사유와 함께 거부한다(Q1, 2026-10-07 사용자 결정).
// 결정 파일은 확장만 쓴다. 이 훅은 used/<id>.json(사용·시간 초과 표시)만 쓴다.
// 오류가 나면 아무것도 돌려주지 않는다 → 평소 흐름(확인 창). 자동 허용은 하지 않는다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../approvalStore');

const WAIT_MS = Number(process.env.WY_PERMISSION_WAIT_MS) || 15 * 60 * 1000; // 테스트에서 줄인다
const POLL_MS = 1000;

const keyOf = (input) =>
  crypto.createHash('sha1').update([input.session_id, input.tool_name, JSON.stringify(input.tool_input || {})].join('|')).digest('hex').slice(0, 16);

// 사람이 읽을 명령 한 줄
function commandOf(input) {
  const t = input.tool_input || {};
  if (typeof t.command === 'string') return t.command;
  if (typeof t.file_path === 'string') return `${input.tool_name} ${t.file_path}`;
  return `${input.tool_name} ${JSON.stringify(t).slice(0, 300)}`;
}

// claude agents의 이 세션 줄({ kind, name, … }). 못 읽거나 못 찾으면 null
function sessionOf(sessionId) {
  try {
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'claude agents --json --all'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return JSON.parse(r.stdout).find((a) => a.sessionId === sessionId) || null;
  } catch {
    return null;
  }
}
const sessionNameOf = (sessionId) => (sessionOf(sessionId) || {}).name || null;

// 아직 결정·사용·만료되지 않은 같은 키의 카드가 있으면 그것을 이어서 기다리고, 없으면 새 id를 정한다
function pickId(p, key) {
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? `perm-${key}` : `perm-${key}-${n}`;
    const req = path.join(p.requests, `${id}.json`);
    if (!fs.existsSync(req)) return { id, reuse: false };
    const done = fs.existsSync(path.join(p.decisions, `${id}.json`)) || fs.existsSync(path.join(p.used, `${id}.json`));
    if (!done) return { id, reuse: true };
  }
  throw new Error('같은 명령의 권한 카드가 너무 많음');
}

function writeRequest(p, id, input, now, sessionName) {
  const command = commandOf(input);
  const who = sessionName || `세션 ${String(input.session_id || '').slice(0, 8)}`;
  store.writeJsonAtomic(path.join(p.requests, `${id}.json`), {
    kind: 'permission',
    key: id.slice('perm-'.length),
    session: who,
    sessionId: input.session_id || null,
    sessionName,
    tool: input.tool_name,
    toolInput: input.tool_input || {},
    command,
    permissionMode: input.permission_mode || null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + WAIT_MS).toISOString(),
    title: `${who}: ${input.tool_name} 실행 허용`,
    what: command,
    why: `${who} 세션이 이 도구를 실행하려고 확인을 기다립니다(ask 규칙·보호 경로 등).`,
    onClick: '허용: 이 한 번만 실행됩니다. 거부: 사유가 세션에 전달되고 실행하지 않습니다. 15분 안에 결정이 없으면 거부됩니다.',
  });
}

function markUsed(p, id, body) {
  fs.mkdirSync(p.used, { recursive: true });
  fs.writeFileSync(path.join(p.used, `${id}.json`), JSON.stringify({ id, at: new Date().toISOString(), ...body }) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 백그라운드 세션만 카드로 받는다. 대화형 세션은 사용자가 터미널 확인 창에 바로 답하므로,
// 15분 기다리면 오히려 확인 창이 늦어진다(pm 결정 2026-10-07). 세션 종류를 모르면 마찬가지로 평소 흐름.
// null을 돌려주면 결정 없이 끝난다 → 확인 창.
async function onPermissionRequest(input, root) {
  const session = sessionOf(input.session_id);
  if (!session || session.kind !== 'background') return null;
  const p = store.ensureDirs(root);
  const key = keyOf(input);
  const { id, reuse } = pickId(p, key);
  const now = new Date();
  if (!reuse) writeRequest(p, id, input, now, session.name || null);
  const deadline = now.getTime() + WAIT_MS;
  const decisionFile = path.join(p.decisions, `${id}.json`);
  while (Date.now() < deadline) {
    if (fs.existsSync(decisionFile)) {
      let d;
      try {
        d = store.readJson(decisionFile);
      } catch {
        await sleep(POLL_MS); // 쓰는 중이면 다시 읽는다
        continue;
      }
      markUsed(p, id, { decision: d.decision, sessionId: input.session_id || null });
      if (d.decision === 'approved') return { behavior: 'allow' };
      return { behavior: 'deny', message: `승인 센터에서 거부됨: ${d.reason || '사유 없음'}` };
    }
    await sleep(POLL_MS);
  }
  markUsed(p, id, { decision: 'expired', sessionId: input.session_id || null });
  return { behavior: 'deny', message: '승인 센터에서 15분 동안 결정이 없어 거부했습니다. 다시 요청하거나 할 일 카드로 올리세요.' };
}

// 분류기 거부 사유를 쉬운 말로(사유 문구는 분류기가 정하므로 흔한 낱말만 본다)
function plainReason(reason) {
  const r = String(reason || '');
  const why = [
    [/scratch|sweep|tmp|temp/i, '여러 세션이 함께 쓰는 임시 폴더를 지우거나 훑는 명령이라, 다른 세션의 작업 파일까지 지울 수 있습니다'],
    [/rm\b|delet|remov|destroy|wipe/i, '파일을 지우는 명령이라 되돌리기 어렵습니다'],
    [/push|force|reset|history|git/i, '저장소 이력이나 원격 저장소를 바꾸는 명령입니다'],
    [/network|curl|download|upload|exfil|external|http/i, '외부와 데이터를 주고받는 명령입니다'],
    [/credential|secret|token|password/i, '비밀값에 닿을 수 있는 명령입니다'],
  ].find(([re]) => re.test(r));
  return (why ? why[1] : '자동 판단이 위험할 수 있다고 본 명령입니다') + (r ? ` (분류기 사유: ${r})` : '');
}

const GIT_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p)) || 'C:\\Program Files\\Git\\bin\\bash.exe';

// Bash 명령을 PowerShell(5.1)에 그대로 붙여 넣을 수 있는 형태로. 작은따옴표 here-string이라 $·따옴표를 고치지 않아도 되고,
// 넘길 때 줄바꿈의 \r을 빼고 Windows 인자 규칙대로 "(와 그 앞 \)를 이스케이프한다(PowerShell 5.1은 이 이스케이프를 하지 않음)
function bashForPowerShell(command) {
  if (/^'@/m.test(command)) return null; // here-string을 닫는 줄이 들어 있으면 만들 수 없다
  return ["$c = @'", command, "'@", `& '${GIT_BASH}' -c (($c -replace "\`r", '') -replace '(\\\\*)"', '$1$1\\"')`].join('\n');
}

function onPermissionDenied(input, root) {
  const p = store.ensureDirs(root);
  const id = `denied-${keyOf(input)}`;
  if (fs.existsSync(path.join(p.requests, `${id}.json`))) return;
  const command = commandOf(input);
  const sessionName = sessionNameOf(input.session_id);
  const who = sessionName || `세션 ${String(input.session_id || '').slice(0, 8)}`;
  const shell = input.tool_name === 'Bash' ? 'bash' : input.tool_name === 'PowerShell' ? 'powershell' : null;
  const ps = shell === 'bash' ? bashForPowerShell(command) : null;
  const advice = "대부분은 실행하지 않아도 됩니다. 판단이 어려우면 실행하지 말고 메모에 '실행 안 함'이라고 적어 '완료'로 닫으세요.";
  const where =
    shell === 'bash'
      ? `Bash 명령입니다. PowerShell에서는 그대로 실행되지 않습니다. Git Bash 창에 붙여 넣거나${ps ? ', 아래 "PowerShell에 붙여 넣을 형태"를 PowerShell에 붙여 넣으세요' : ' Git Bash 창에서만 실행하세요(PowerShell 형태를 만들 수 없는 명령)'}.`
      : shell === 'powershell'
        ? 'PowerShell 명령입니다. VS Code의 PowerShell 터미널에 그대로 붙여 넣으세요(Git Bash에서는 실행되지 않음).'
        : `${input.tool_name} 도구 동작입니다(셸 명령이 아님). 필요하면 같은 작업을 직접 하세요.`;
  store.writeJsonAtomic(path.join(p.requests, `${id}.json`), {
    kind: 'todo',
    session: who,
    sessionId: input.session_id || null,
    createdAt: new Date().toISOString(),
    title: `${who}: 분류기가 막은 ${shell === 'bash' ? 'Bash' : shell === 'powershell' ? 'PowerShell' : input.tool_name} 명령`,
    what: `${advice} ${where}`, // 명령은 command 칸으로 따로 보인다(화면이 what의 줄바꿈을 살리지 않아 명령이 붙어 두 번 보이던 것)
    why: `${advice} ${plainReason(input.reason)}. 훅으로 뒤집지 않으므로 사람이 실행할지 정합니다.`,
    onClick: "완료:직접 실행했거나 실행하지 않기로 했음을 세션에 알립니다(메모에 '실행함'·'실행 안 함'을 적으면 세션이 그에 맞춰 이어 갑니다).",
    tool: input.tool_name || null,
    shell,
    command,
    ...(ps ? { commandPowerShell: ps } : {}),
    steps: [advice, where, '실행했다면 결과(출력·오류)를 메모에 적고 \'완료\'를 누릅니다.'],
    check: shell === 'bash' ? '명령이 오류 없이 끝나면 됩니다. "unexpected token" 같은 문법 오류는 PowerShell에 Bash 명령을 붙여 넣은 경우입니다.' : '명령이 오류 없이 끝나면 됩니다.',
  });
}

function respond(decision) {
  if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
  process.exit(0);
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(raw);
      const root = store.rootFor(input.cwd || process.cwd());
      if (input.hook_event_name === 'PermissionDenied') {
        onPermissionDenied(input, root);
        process.exit(0);
      }
      respond(await onPermissionRequest(input, root));
    } catch (err) {
      // 판단하지 못하면 평소 흐름으로 둔다(허용하지 않음)
      process.stderr.write(`WY 권한 훅 오류: ${err.message}\n`);
      process.exit(0);
    }
  });
}

module.exports = { keyOf, commandOf, pickId, onPermissionRequest, onPermissionDenied, bashForPowerShell, plainReason };
