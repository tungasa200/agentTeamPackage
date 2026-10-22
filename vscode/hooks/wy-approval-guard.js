#!/usr/bin/env node
// wy-ops 승인 가드(PreToolUse 훅, Bash·PowerShell). 초안 — 적용은 사용자 설정에서 한다.
// - 잠금 대상 git 명령: commit·push·강제 푸시·브랜치 생성/삭제·merge(gh pr merge)·reset·rebase·태그 삭제·worktree 추가/삭제(pull·cherry-pick·revert·am·update-ref·fetch a:b 등 포함). 모두 승인 센터의 승인 결정이 있어야 한다.
//   env·&·bash -c·cmd /c·powershell -c·Start-Process 등으로 감싼 git도 본다. git 별칭·외부 명령(내장이 아닌 하위 명령)은 아무도 실행 못 한다.
//   해석할 수 없는 형태(D-38: 쪼갠 이름·변수 프로그램·실행 설정·다른 프로그램이나 코드가 대신 실행하는 git)는 판단할 수 없어 막는다.
//   here-doc 본문은 데이터로 보되, 본문을 셸·인터프리터나 모르는 프로그램이 받으면 명령·코드로 본다.
// - 예외 하나(S4, D-32): 역할 세션이 자기 worktree(.claude/worktrees/<자기 역할>, 가지 wt/<자기 역할>)에서 `git merge <worktree.base>`만 한 명령은 승인 없이 통과.
// - 잠금 대상은 프로젝트 설정의 커밋 역할(wy-ops.json commitRole, agent_type)만 실행한다. agent_type이 없는 세션도, 설정이 없으면 모두 거부한다.
// - 승인 한 건은 한 번만 쓴다(used/<id>.json).
// - 승인 폴더는 훅 입력의 cwd가 속한 프로젝트의 것(~/.claude/wy-approvals/<namespace>, 설정이 없으면 바탕 폴더).
// - 승인 파일(decisions/·decisions.log·used/·sessions/·message-blocks.log·기기 명부 .trust/), 설치본(~/.wy-tools), 프로젝트 설정(.claude/wy-ops.json·wy-ops.local.json·settings.local.json)에
//   쓰는 셸 명령은 막는다. 읽기(cat·ls·tail·test, 감시 루프)와 읽기 API만 쓰는 node·python·PowerShell 코드는 통과한다.
//   판단할 수 없으면(쓰기 API·난독화·알 수 없는 코드) 막는다.
//   설치본 CLI는 읽기 전용 하위 명령(install.ps1 doctor·도움말)만 통과(허용 목록), PowerShell 내용 쓰기의 내용(here-string)은 데이터로 본다.
// 훅은 오류·시간 초과 때 통과시키므로(fail open), 여기서는 어떤 오류든 종료 코드 2로 막는다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../approvalStore');
const { loadOpsConfig } = require('../opsConfig');

// 기본값. 훅 입력의 cwd에서 프로젝트 설정(.claude/wy-ops.json)을 찾으면 commitRole·approvals.ttlMinutes를 쓴다
const DEFAULT_TTL_MINUTES = 60; // 결정 후 이 시간 안에만 쓸 수 있다
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
// 보호 경로(소문자, / 구분자로 바꾼 명령에 대고 찾는다). 승인 파일은 바탕 폴더 바로 아래와 <namespace> 하위 모두. .trust/는 기기 명부(바탕 폴더에 하나)
const PROTECTED = [
  /wy-approvals\/(?:[^/\s"'`]+\/)?(?:decisions|used\b|sessions\b|config\.json|message-blocks\.log|\.trust\b)/,
  /\.wy-tools\//,
  /\.claude\/(?:wy-ops(?:\.local)?\.json|settings\.local\.json)/,
];
// 파일을 쓰거나 지울 수 있는 프로그램(PowerShell 별칭 포함)
const WRITERS = new Set([
  'cp', 'mv', 'rm', 'rmdir', 'del', 'erase', 'copy', 'move', 'ren', 'rename', 'touch', 'mkdir', 'tee', 'truncate', 'dd', 'install', 'ln', 'chmod', 'chown', 'xargs',
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'new-item', 'ni', 'remove-item', 'ri', 'rd', 'copy-item', 'cpi', 'move-item', 'mi',
  'rename-item', 'rni', 'clear-content', 'clc', 'set-item', 'si', 'tee-object', 'invoke-expression', 'iex', 'start-process',
]);
// 코드를 받아 실행하는 프로그램. 코드 안을 보고 읽기만 하는지 판단한다
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'perl', 'ruby', 'deno', 'bun', 'powershell', 'pwsh', 'cmd', 'bash', 'sh']);
// 쓰기·실행 API. 하나라도 있으면 막는다
const WRITE_API = new RegExp(
  [
    'writeFile', 'appendFile', 'createWriteStream', 'copyFile', 'cpSync', '\\brename', 'unlink', '\\brm(?:Sync)?\\s*\\(', 'rmdir', 'mkdir', 'symlink', '\\blink(?:Sync)?\\s*\\(',
    'truncate', 'chmod', 'chown', 'utimes', '\\.write\\s*\\(', 'write_text', 'write_bytes', 'shutil\\.', 'os\\.(?:remove|rename|replace|unlink|makedirs|mkdir|rmdir|system|popen)',
    'subprocess', 'child_process', '\\bexecSync', '\\bspawn', '\\bopen\\s*\\([^)]*,\\s*(?:mode\\s*=\\s*)?[\'"][^\'"]*[wax+]',
    'Set-Content', 'Add-Content', 'Out-File', 'New-Item', 'Remove-Item', 'Copy-Item', 'Move-Item', 'Rename-Item', 'Clear-Content', 'Set-Item', 'Tee-Object', 'Start-Process',
    '\\]::(?:Write|Append|Copy|Move|Delete|Create|Replace|Open)', '\\bdel\\s', '\\bcopy\\s', '\\bmove\\s',
  ].join('|'),
  'i',
);
// 쓰기 API를 숨기는 흔한 방법(계산된 이름, eval 등). 있으면 판단할 수 없으니 막는다
const OBFUSCATION = /\[[^\]]*\+[^\]]*\]|\beval\b|\bFunction\s*\(|getattr|__import__|\bexec\s*\(|\bcompile\s*\(|fromCharCode|\batob\b|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|Buffer\.from|Invoke-Expression|\biex\b|-EncodedCommand|-enc\b|globalThis|process\.binding|\bimportlib\b/i;
// 읽기 API. 인터프리터 코드가 이것만 쓰면 통과
const READ_API = /readFileSync|readFile|\brequire\s*\(|existsSync|statSync|readdirSync|JSON\.parse|json\.load|\bopen\s*\(|read_text|Get-Content|Test-Path|Get-ChildItem|Get-Item|ConvertFrom-Json|Select-String|\bsls\b|Select-Object|Measure-Object|\]::(?:ReadAll|Exists)|\bcat\b|\btype\b/i;
// .NET 파일·폴더 객체의 쓰기 메서드((Get-Item p).Delete(), $fi.MoveTo(…)). 문자열 .Replace(는 넣지 않는다
// 받는 쪽은 조각 맨 앞의 (PowerShell 명령 …) 또는 $변수뿐이다(JS 코드의 .append( 등과 섞지 않게)
const PS_WRITE_METHOD = /^(?:\(\s*(?:[A-Za-z]+-[A-Za-z]+|gi|gci)\b(?:[^()]|\([^()]*\))*\)|\$[\w:]+)\.(?:Delete|MoveTo|CopyTo|OpenWrite|AppendText|CreateText|CreateSubdirectory|Encrypt|Decrypt|SetAccessControl|Write\w*|Append\w*)\s*\(/i;
// 버리는 리다이렉트 대상
const NULL_TARGET = /^(?:\/dev\/null|nul|\$null|&\d)$/i;
const LEADING_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'until', 'while', 'if', '!', '{', '(']); // 실행기(time·exec·sudo·env·& …)는 RUNNERS·stripRunners가 옵션과 함께 뗀다

// 명령을 &&, ||, ;, |, 줄바꿈으로 나눈다(따옴표 안은 나누지 않는다). pipes=false면 파이프(|)로는 나누지 않는다(파이프라인을 한 덩어리로)
function segments(command, pipes = true) {
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '|' && !pipes && command[i + 1] !== '|') {
      cur += ch;
    } else if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && !/[<>&]/.test(command[i - 1] || '') && command[i + 1] !== '>')) {
      // 홑 & (뒤로 돌리기·cmd 이어 쓰기)도 나눈다. 리다이렉트(2>&1·&>·>&2)는 빼고
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// 블록·하위 셸·명령 치환 안의 명령 조각(KI-08 A1): 작은따옴표 밖의 ( ) { } 와 백틱 안쪽을 다시 조각으로 나눈다(안쪽의 안쪽도).
// 큰따옴표 안에서는 $( )와 백틱만 실행된다. 맨 위 조각(segments)에 더해 같은 판정을 받는다
function innerSegments(s, depth = 0, pipes = true) {
  const out = [];
  // 너무 깊게 묶인 명령은 판단하지 않고 막는다(오류는 종료 코드 2)
  if (depth > 8) throw new Error('괄호·블록이 너무 깊게 묶인 명령');
  let dq = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !dq) {
      const j = s.indexOf("'", i + 1);
      if (j < 0) break;
      i = j;
      continue;
    }
    if (c === '"') dq = !dq;
    const end = c === '`' ? s.indexOf('`', i + 1) : (c === '(' && (!dq || s[i - 1] === '$')) || (c === '{' && !dq) ? closeParen(s, i) : -1;
    if (end < 0) continue;
    // 안쪽의 데이터 here-doc 본문(cat·tee, 커밋 메시지 "$(cat <<'EOF' …)")은 명령이 아니다
    const inner = splitHeredocs(s.slice(i + 1, end)).code;
    out.push(...segments(inner, pipes), ...innerSegments(inner, depth + 1, pipes));
    i = end;
  }
  return out;
}
const allSegments = (s) => [...segments(s), ...innerSegments(s)];

function tokens(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

// git 내장 명령(2.55 `git --list-cmds=main,nohelpers`). 이 밖의 하위 명령은 별칭(-c alias.*·설정 파일·GIT_CONFIG_* 환경 변수)이나
// 외부 명령(git-<이름>)이라 무엇을 하는지 모른다 → 'unknown'(아무도 실행 못 함). 내장 이름은 별칭이 덮지 못한다(git이 무시)
const GIT_BUILTINS = new Set(
  ('add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout ' +
    'checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential credential-cache ' +
    'credential-store credential-wincred daemon describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch ' +
    'fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch format-rev fsck fsck-objects gc get-tar-commit-id grep gui hash-object ' +
    'help history hook http-backend http-fetch http-push imap-send index-pack init init-db interpret-trailers last-modified log ls-files ls-remote ls-tree ' +
    'mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-octopus merge-one-file merge-ours merge-recursive merge-recursive-ours ' +
    'merge-recursive-theirs merge-resolve merge-subtree merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant ' +
    'pack-refs patch-id pickaxe prune prune-packed pull push quiltimport range-diff read-tree rebase receive-pack reflog refs remote remote-ext remote-fd ' +
    'remote-ftp remote-ftps remote-http remote-https repack replace replay repo request-pull rerere reset restore rev-list rev-parse revert rm send-email ' +
    'send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule subtree survey switch symbolic-ref ' +
    'tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive upload-pack url-parse var verify-commit verify-pack ' +
    'verify-tag version whatchanged worktree write-tree').split(' '),
);
// 프로그램 앞에 붙어 그 프로그램을 실행하는 것(env git commit, & git commit, nohup·timeout·nice …). 붙은 옵션·숫자 인자도 뗀다
const RUNNERS = new Set(['env', 'exec', 'sudo', 'time', 'command', 'builtin', 'nohup', 'nice', 'timeout', 'stdbuf', 'xargs', '&', 'start-process', 'saps', 'start', 'call']);
const ARG_RUNNERS = new Set(['xargs', 'start-process', 'saps', 'start']);
function stripRunners(t, verbatimOnly = false) {
  for (;;) {
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t = t.slice(1); // 앞의 VAR=값
    const p = progName(t);
    if (!RUNNERS.has(p) || (verbatimOnly && ARG_RUNNERS.has(p)) || (p === 'command' && /^-[vV]$/.test(t[1] || ''))) return t; // command -v는 찾기만 한다
    t = t.slice(1);
    while (t.length && (/^-|^\/[A-Za-z]+$/.test(t[0]) || /^\d+(?:\.\d+)?[smhd]?$/.test(t[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]))) {
      // env -S '명령 문자열'은 그 문자열을 나눠 실행한다
      if (p === 'env' && /^(?:-S|--split-string)$/.test(t[0])) t = [...tokens(t[1] || ''), ...t.slice(2)];
      else if (p === 'env' && /^(?:-S.|--split-string=)/.test(t[0])) t = [...tokens(t[0].replace(/^-S|^--split-string=/, '')), ...t.slice(1)];
      else t = t.slice((RUNNER_VALUE_OPTS[p] || []).includes(t[0]) ? 2 : 1);
    }
  }
}
// 실행기 옵션 중 값을 따로 받는 것(xargs -I {}, env -u X, timeout -k 5 …). 실행기마다 다르다(sudo -E는 값 없음, xargs -E는 값)
const RUNNER_VALUE_OPTS = {
  env: ['-u', '-C', '--unset', '--chdir'],
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-R', '-T', '--user', '--group', '--chdir', '--host', '--prompt', '--role', '--type', '--other-user', '--chroot', '--command-timeout'],
  xargs: ['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars', '--max-lines', '--process-slot-var'],
  timeout: ['-k', '-s', '--signal', '--kill-after'],
  nice: ['-n', '--adjustment'],
  stdbuf: ['-i', '-o', '-e'],
};
// 셸·PowerShell·cmd가 실행할 명령 문자열(bash -c '…', cmd /c …, powershell [-Command] …, -EncodedCommand, iex '…'). 없으면 null(스크립트 파일 등)
const PS_VALUE_OPTS = ['ep', 'wd', 'executionpolicy', 'windowstyle', 'version', 'inputformat', 'outputformat', 'configurationname', 'psconsolefile', 'workingdirectory', 'settingsfile'];
function shellCode(t) {
  const p = progName(t);
  const rest = t.slice(1);
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(p)) {
    const i = rest.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : null;
  }
  if (p === 'cmd') {
    const i = rest.findIndex((a) => /^\/[ck]$/i.test(a));
    return i >= 0 ? rest.slice(i + 1).join(' ') : null;
  }
  if (p === 'iex' || p === 'invoke-expression') return rest.filter((a) => !/^-command$/i.test(a)).join(' ') || null;
  if (p !== 'powershell' && p !== 'pwsh') return null;
  for (let i = 0; i < rest.length; i++) {
    const f = /^[-/]([A-Za-z]+)(?::([\s\S]*))?$/.exec(rest[i]);
    if (!f) return rest.slice(i).join(' '); // 위치 인자는 -Command의 값
    const n = f[1].toLowerCase();
    // -Command:값·-EncodedCommand:값처럼 콜론에 붙인 값도 본다(D-38). -ec는 -EncodedCommand의 별칭
    const after = f[2] !== undefined ? [f[2], ...rest.slice(i + 1)] : rest.slice(i + 1);
    if ('command'.startsWith(n)) return after.join(' ');
    if (n === 'e' || n === 'ec' || (n.length >= 2 && 'encodedcommand'.startsWith(n))) return Buffer.from(after[0] || '', 'base64').toString('utf16le');
    if ('file'.startsWith(n)) return null;
    if (PS_VALUE_OPTS.some((o) => o.startsWith(n)) && !rest[i].includes(':')) i++;
  }
  return null;
}

// ── D-38 '해석 못 하면 거부': 풀지 못한 형태에 git이 보이면 unknown ──────────────────
// git 낱말(따옴표·백틱·^·+로 쪼갠 것도 이어 본다). .git 폴더·github·git-lfs 같은 낱말은 아니다
const GIT_WORD = /(?:^|[^\w.-])git(?:\.exe)?(?![\w-])/i;
const gitWord = (s) => GIT_WORD.test(String(s).replace(/['"`^+]/g, '').replace(/\\/g, '/'));
// 다른 프로세스를 실행하는 코드 API(인터프리터 코드 안, X3)
const EXEC_API = /child_process|\bexec(?:File)?(?:Sync)?\s*\(|\bspawn(?:Sync)?\s*\(|\bfork\s*\(|subprocess|os\.(?:system|popen|exec\w*|spawn\w*)|\bPopen\b|\bsystem\s*\(|\bqx\b|Open3|IO\.popen|Process\.Start|Start-Process|Deno\.(?:run|Command)|Bun\.spawn/i;
// perl·ruby는 백틱(`git push`)도 실행이다. node·python의 백틱은 글자(템플릿 문자열·문서 조각)라 보지 않는다
// 실행 API는 코드의 문자열 글자 밖에서만 찾는다(문서·시험 코드를 고치는 스크립트의 글자 속 spawnSync·Start-Process는 실행이 아니다)
const CODE_STRINGS = /`(?:[^`\\]|\\.)*`|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
// 모듈 이름은 대개 문자열 안에 있어(require('child_process'), __import__('subprocess')) 글자를 떼기 전 코드로 본다.
// perl·ruby는 괄호 없는 system "…"·exec·%x{}·open(…'|')도 실행이다
const EXEC_MOD = /child_process|subprocess|\bOpen3\b/i;
const execCode = (prog, code) =>
  EXEC_MOD.test(code) || EXEC_API.test(code.replace(CODE_STRINGS, '""')) || (['perl', 'ruby'].includes(prog) && (/`[^`]*\bgit\b/i.test(code) || /\b(?:system|exec|spawn|open|popen)\b|%x/.test(code)));
// 따옴표를 남긴 채 공백으로 나눈 낱말(따옴표·here-string 안 공백은 나누지 않는다)
const rawWords = (s) => s.match(/@'[\s\S]*?\n'@|@"[\s\S]*?\n"@|(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"])+/g) || [];
// 프로그램 자리가 변수·식인지(X2): & $g push, & ('gi'+'t') push, bash의 $G push.
// 변수를 같은 명령에서 글자 값으로 정했고 그 값에 git이 없으면($s='…\session.ps1'; & $s stop …) 아니다. 값을 모르면(정한 곳 없음·식) 그렇다고 본다
function varProgram(raw, t, ctx) {
  const callOp = ['&', '.'].includes(raw.find((a) => !LEADING_KEYWORDS.has(a)));
  const pureVar = /^\$\{?([A-Za-z_][\w:]*)\}?$|^%(\w+)%$/.exec(t[0]);
  if (!(callOp && /^[$(%]|[+'"`]/.test(t[0]))) {
    // foreach ($f in …)의 머리, $x += …·$i++ 같은 연산은 실행이 아니다
    if (!pureVar || t.length < 2 || PS_OP.test(t[1]) || /^(?:in|=|[-+*/%]=|\?\?=|\+\+|--)$/i.test(t[1])) return false;
    // 앞 낱말이 키워드·대입만일 때 진짜 첫 낱말이다(T=$(cygpath "$TEMP")/x처럼 나뉜 값의 조각은 아니다)
    const at = raw.indexOf(t[0]);
    if (at < 0 || raw.slice(0, at).some((a) => !LEADING_KEYWORDS.has(a) && !['&', '.'].includes(a) && !/^[A-Za-z_]\w*=[^$`(]*$/.test(a))) return false;
  }
  if (!pureVar) return true;
  const n = (pureVar[1] || pureVar[2]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assigns = [
    // bash 대입(NAME=값, 대소문자 구분, 붙은 따옴표 조각 'g''it'까지)과 PowerShell 대입($name = 값, ; | 줄 끝까지 오른쪽 전체)
    ...[...ctx.matchAll(new RegExp(`(?:^|[\\s;&|({])${n}=((?:"[^"]*"|'[^']*'|[^\\s;&|)'"])*)`, 'g'))].map((m) => m[1]),
    ...[...ctx.matchAll(new RegExp(`\\$${n}\\s*=\\s*([^;\\n|]*)`, 'gi'))].map((m) => m[1].trim()),
  ];
  const lists = [...ctx.matchAll(new RegExp(`\\b(?:for|foreach)\\s*\\(?\\s*\\$?${n}\\s+in\\s+([^;)\\n]*)`, 'gi'))].map((m) => m[1]);
  // 대입 값은 글자 하나('…'·"…"·맨 낱말)일 때만 안다('g'+'it'·-join·여러 조각은 모른다)
  const single = (v) => /^(?:'[^']*'|"[^"$`]*"|[^\s'"$`(+]*)$/.test(v);
  return !(assigns.length + lists.length) || assigns.some((v) => gitWord(v) || !single(v)) || lists.some((v) => gitWord(v) || /[$`(]/.test(v.replace(/^'[^']*'$/, '')));
}
// 실행하는 설정(-c·GIT_CONFIG_*·--config-env·git config로 쓰기, U7·X1). 이 설정이 붙은 git은 무엇을 실행할지 모른다
const EXEC_CONFIG = /^(?:core\.(?:pager|sshcommand|editor|fsmonitor|hookspath|askpass|alternaterefscommand|gitproxy)|pager\..+|credential(?:\..+)?\.helper|sequence\.editor|diff\.external|diff\..+\.(?:textconv|command)|merge\..+\.driver|filter\..+|gpg(?:\..+)?\.program|alias\..+|protocol\..+|uploadpack\.packobjectshook|sendemail\..+|remote\..+\.(?:uploadpack|receivepack)|include(?:if\..+)?\.path|interactive\.difffilter|(?:merge|diff)tool\..+|ssh\.variant|init\.templatedir)$/i;
// 하위 명령 자리 낱말로 풀 수 있는 글자(U1). 이 밖(따옴표 섞임·\·$·백틱·^·%·@·괄호·와일드카드)은 셸이 무엇으로 바꿀지 모른다
const PLAIN_WORD = /^[A-Za-z0-9._-]+$/;
// git을 다른 이름에 거는 명령(X1)
const ALIASERS = new Set(['alias', 'set-alias', 'sal', 'new-alias', 'nal', 'doskey']);
// git 낱말이 인자로 나와도 실행하지 않는 프로그램(X4에서 뺀다): 출력·찾기·읽기·이동
const NON_EXEC = new Set([...'echo printf write-host write-output grep rg findstr select-string sls which where get-command gcm type man help ls dir cat head tail wc test test-path get-item gi get-childitem gci get-content gc cd set-location sl pushd code winget choco scoop mkdir rm rmdir cp mv touch get-process gps ps pgrep pkill pidof stop-process spps kill taskkill tasklist'.split(' ')]);
// PowerShell 비교·문자열 연산자($x -match 'git'는 실행이 아니다)
const PS_OP = /^-(?:c|i)?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join|is|isnot|as|and|or|xor|not|band|bor|f)$/i;

// Start-Process(saps)의 매개변수를 푼다(U5): -FilePath·-ArgumentList(줄임·콜론형·순서 무관·쉼표 목록·@('…') 글자 목록).
// 돌려줌 { files: FilePath 후보(변수 값에 공백이 있어 쪼개졌을 때 두 해석), args: 인자(글자로 못 풀면 null), redirects } 또는 null(풀 수 없음)
const SP_PARAMS = { filepath: 1, path: 'filepath', pspath: 'filepath', argumentlist: 1, args: 'argumentlist', workingdirectory: 1, credential: 1, redirectstandarderror: 1, redirectstandardinput: 1, redirectstandardoutput: 1, windowstyle: 1, verb: 1, environment: 1, loaduserprofile: 0, lup: 'loaduserprofile', nonewwindow: 0, nnw: 'nonewwindow', passthru: 0, wait: 0, usenewenvironment: 0 };
function spParam(name) {
  const n = name.toLowerCase();
  const canon = (k) => (typeof SP_PARAMS[k] === 'string' ? SP_PARAMS[k] : k);
  if (n in SP_PARAMS) return canon(n);
  const hits = [...new Set(Object.keys(SP_PARAMS).filter((k) => k.startsWith(n)).map(canon))];
  return hits.length === 1 ? hits[0] : null;
}
function spLiteral(item) {
  if (/^'[^']*'$/.test(item)) return item.slice(1, -1);
  if (/^"[^"]*"$/.test(item)) return /[$`]/.test(item) ? null : item.slice(1, -1);
  return /[$@(){}`'"]/.test(item) ? null : item;
}
function startProcess(segment) {
  const m = /(?:^|[\s&(])(?:start-process|saps|start)(?:\.exe)?(?=\s|$)/i.exec(segment);
  if (!m) return null;
  const items = segment.slice(m.index + m[0].length).match(/@\((?:[^()'"]|'[^']*'|"[^"]*")*\)|,|(?:'[^']*'|"[^"]*"|[^\s,'"])+/g) || [];
  const named = {};
  const pos = [];
  // 쉼표로 이은 값 목록. @('a','b')는 안을 같은 규칙으로 푼다. 글자로 못 푸는 원소는 null
  const list = (i, first) => {
    const out = [];
    const take = (it) => {
      if (/^@\(/.test(it)) {
        const inner = it.slice(2, -1).match(/'[^']*'|"[^"]*"|[^\s,;'"]+/g) || [];
        out.push(...inner.map(spLiteral));
      } else out.push(spLiteral(it));
    };
    take(first);
    while (items[i + 1] === ',' && items[i + 2] !== undefined) {
      take(items[i + 2]);
      i += 2;
    }
    return [out, i];
  };
  for (let i = 0; i < items.length; i++) {
    const p = /^-([A-Za-z]+)(:?)([\s\S]*)$/.exec(items[i]);
    if (p) {
      const name = spParam(p[1]);
      if (!name) return null;
      if (SP_PARAMS[name] === 0) continue; // 스위치(-Wait·-PassThru, -Wait:$true)
      let v;
      if (p[2] && p[3]) [v, i] = list(i, p[3]);
      else if (items[i + 1] !== undefined) [v, i] = list(i + 1, items[i + 1]);
      else return null;
      named[name] = v;
      continue;
    }
    if (items[i] === ',') return null;
    let v;
    [v, i] = list(i, items[i]);
    pos.push(v);
  }
  // FilePath 뒤에 떨어진 낱말: 변수 값(공백 든 경로)이 풀려 쪼개졌거나 위치 인자(ArgumentList)다. 두 해석을 모두 본다
  const fileList = named.filepath || pos.shift();
  if (!fileList || fileList.length !== 1 || fileList[0] === null) return null;
  const files = [fileList[0]];
  if (!named.argumentlist && named.filepath && pos.length && pos.every((v) => v.length === 1 && v[0] !== null)) files.push([fileList[0], ...pos.map((v) => v[0])].join(' '));
  const argList = named.argumentlist || pos.shift();
  if (pos.length && !(files.length > 1)) return null;
  const args = !argList ? [] : argList.includes(null) ? null : argList;
  const redirects = ['redirectstandarderror', 'redirectstandardinput', 'redirectstandardoutput'].flatMap((k) => named[k] || []);
  return { files, args, redirects, wd: named.workingdirectory };
}

// 한 조각이 잠금 대상이면 종류를, 아니면 null. 셸 문자열 안(bash -c 'git commit')도 본다.
// ctx: 명령 전체(변수에 담은 git을 다른 조각에서 부르는 경우, X2). 없으면 이 조각으로 본다
function classify(segment, depth = 0, ctx = segment) {
  const raw = tokens(segment);
  // 셸 키워드(if·while·!·then·do …)·PowerShell 대입($x = git …)은 떼고 그 뒤 명령으로 본다(D-38)
  const lead = leadingTokens(segment);
  // Start-Process는 풀어서 'file args' 명령으로 다시 본다. 못 풀면 git이 보일 때 unknown(U5)
  if (['start-process', 'saps'].includes(progName(lead)) || (progName(lead) === 'start' && lead.slice(1).some((a) => /^-[A-Za-z]+:?/.test(a) && spParam(a.replace(/^-|:.*$/g, ''))))) {
    if (depth >= 6) return 'unknown';
    const sp = startProcess(segment);
    if (!sp || !sp.args || sp.files.length > 1) return gitWord(segment) ? 'unknown' : null;
    return classify([/\s/.test(sp.files[0]) ? `"${sp.files[0]}"` : sp.files[0], ...sp.args].join(' '), depth + 1, ctx);
  }
  // 따옴표가 깨져 조각에 셸 연산자(| & ;)가 남았으면 그 앞까지만 이 명령이다
  const full = stripRunners(lead);
  const cut = full.findIndex((a, j) => j > 0 && /^[&|;]+$/.test(a));
  const t = cut < 0 ? full : full.slice(0, cut);
  if (!t.length) return null;
  // PowerShell 배열 식("…\git.exe","…")은 실행이 아니다
  if (/^(["'])[^"']*\1,/.test(segment.trim())) return null;
  // 프로그램 이름을 따옴표·\·^로 쪼갰는데 풀면 git·gh(U2)
  //   bash는 붙은 따옴표 조각("…\gi""t.exe")을 한 낱말로 잇고 g\it의 \를 뗀다. 따옴표를 남긴 낱말로 본다.
  //   맨 앞 &가 조각 나누기로 떨어진 PowerShell 식(('gi'+'t') push)도 이어 본다
  const unq = (w) => w.replace(/['"`^+()]/g, '');
  const bare = unq(rawWords(segment).find((w) => unq(w).startsWith(unq(t[0]))) || t[0]);
  const isGit = (s) => ['git', 'gh'].includes(progName([s]));
  if (!isGit(t[0]) && !/[,;]/.test(bare) && (isGit(bare) || isGit(bare.replace(/\\(?=[^\\/]*$)/, '')))) return 'unknown';
  // 프로그램 자리가 변수·식(X2): & $g push, & ('gi'+'t') push, bash의 $G push. 명령에 git 낱말이 있을 때만
  if (gitWord(ctx) && varProgram(raw, t, ctx)) return 'unknown';
  if (ALIASERS.has(progName(t)) && gitWord(segment)) return 'unknown'; // X1: git을 다른 이름에
  const inner = shellCode(t);
  if (inner) {
    // 3단 이상 셸 문자열은 판단하지 않고 막는다(U3). 이스케이프한 따옴표로 정확히 못 나누는 문자열에 git이 있어도
    if (depth >= 2) return 'unknown';
    if (gitWord(segment) && /\\["']|""|`/.test(segment)) return 'unknown';
    // 승인은 종류 하나에 하나라, 문자열 안에 잠금 명령이 여럿(sh -c 'git commit …; git push')이면 판단하지 않고 막는다
    const kinds = allSegments(inner).map((s) => classify(s, depth + 1, ctx)).filter(Boolean);
    return kinds.length > 1 ? 'unknown' : kinds[0] || null;
  }
  const prog = progName(t);
  // powershell에서 실행할 코드를 못 찾았는데(모르는 매개변수) git이 보이면(U4). -File 스크립트는 남는 위험
  if ((prog === 'powershell' || prog === 'pwsh') && gitWord(segment) && !t.slice(1).some((a) => /^[-/]f(?:i|il|ile)?(?::|$)/i.test(a))) return 'unknown';
  // 인터프리터 코드가 다른 프로세스를 실행하면서 git이 보이면(X3)
  if (CODE_INTERPRETERS.has(prog) && execCode(prog, t.slice(1).join(' ')) && gitWord(segment)) return 'unknown';
  if (prog === 'gh') return t[1] === 'pr' && t[2] === 'merge' ? 'merge' : null;
  if (prog !== 'git') {
    // 실행기 목록 밖 프로그램의 인자에 git이 따로 서 있으면(find -exec git …, ssh h git …) 무엇을 실행할지 모른다(X4).
    // 프로그램 자리가 글자 이름일 때만(# 주석·함수 정의·식은 아니다). command -v git은 찾기만 한다. find는 -exec 뒤만 본다
    if (NON_EXEC.has(prog) || !/^[\w.~\\/][\w.:\\/~-]*$/.test(t[0]) || (prog === 'command' && /^-[vV]$/.test(t[1] || ''))) return null;
    // 따옴표 안 글(here-string·메시지)의 git 낱말은 인자가 아니다. 통째로 따옴표로 감싼 'git'은 인자다
    const all = rawWords(segment);
    const stop = all.findIndex((w, j) => j > 0 && /^[&|;]+$/.test(w));
    const words = stop < 0 ? all : all.slice(0, stop);
    const at = words.findIndex((w) => w.replace(/['"]/g, '') === t[0]);
    const from = prog === 'find' ? words.findIndex((a, j) => j > at && /^-(?:exec|execdir|ok|okdir)$/.test(a)) : at;
    // 코드 연산자(!== === =>)가 끼면 따옴표가 깨져 남은 코드 조각이다(node -e "… p !== 'git' …")
    if (at < 0 || from < 0 || words.some((w) => /^(?:[!=]==?|=>)$/.test(w))) return null;
    // 경로를 붙인 것은 git(소문자)·git.exe만 프로그램으로 본다(…\Program Files\Git은 폴더)
    return words.slice(from + 1).some((a) => /^(['"]?)(?:[Gg][Ii][Tt]|[^\s'"]*[\\/]git|(?:[^\s'"]*[\\/])?[Gg][Ii][Tt]\.[Ee][Xx][Ee])\1$/.test(a)) ? 'unknown' : null;
  }
  let i = 1;
  // -c 이름=값. 환경 변수 GIT_CONFIG_KEY_n·VALUE_n·PARAMETERS로 준 설정도 넣는다
  const env = Object.fromEntries(raw.map((a) => /^(GIT_CONFIG_\w+)=(.*)$/.exec(a)).filter(Boolean).map((m) => [m[1], m[2]]));
  const config = Object.keys(env).filter((k) => /^GIT_CONFIG_KEY_\d+$/.test(k)).map((k) => `${env[k]}=${env[k.replace('KEY', 'VALUE')] || ''}`);
  if (env.GIT_CONFIG_PARAMETERS) config.push(...env.GIT_CONFIG_PARAMETERS.split(/'\s+'/).map((c) => c.replace(/'/g, '')));
  while (i < t.length && t[i].startsWith('-')) {
    if (t[i] === '-c') config.push(t[i + 1] || '');
    else if (t[i].startsWith('--config-env')) config.push(t[i].replace(/^--config-env=?/, '') || t[i + 1] || '');
    i += GIT_OPTS_WITH_VALUE.has(t[i]) || t[i] === '--config-env' ? 2 : 1;
  }
  // 실행하는 설정(core.pager·credential.helper …)이나 값이 !(셸 명령)인 설정이 붙으면 무엇을 실행할지 모른다(U7)
  if (config.some((c) => EXEC_CONFIG.test(c.split('=')[0]) || /^[^=]*=\s*!/.test(c.replace(/['"]/g, '')))) return 'unknown';
  const sub = t[i];
  // 하위 명령을 입력으로 받는 것(echo push | xargs git)은 무엇을 할지 모른다
  if (sub === undefined) return raw.some((a) => /^xargs$/i.test(a)) ? 'unknown' : null;
  // 하위 명령과 인자를 한 문자열로 준 것(Start-Process git 'push origin main')은 펼쳐서 본다
  if (/\s/.test(sub)) return depth >= 6 ? 'unknown' : classify(['git', ...t.slice(1, i), sub, ...t.slice(i + 1)].join(' '), depth + 1, ctx);
  // 하위 명령 자리에 따옴표·\·^·백틱이 섞이면 떼고 다시 본다: 잠금·별칭이면 unknown, 아니면(깨진 따옴표가 남긴 stash\ 등) 보지 않는다(U1).
  // $·%·괄호·와일드카드 등은 셸이 무엇으로 바꿀지 모른다
  if (!PLAIN_WORD.test(sub)) {
    // (cd x && git status)의 닫는 괄호: 괄호 안 조각(innerSegments)이 따로 판정된다
    if (PLAIN_WORD.test(sub.replace(/[)}]+$/, ''))) return null;
    const clean = sub.replace(/['"`^\\]/g, '');
    if (!PLAIN_WORD.test(clean) || depth >= 6) return 'unknown';
    return classify(['git', ...t.slice(1, i), clean, ...t.slice(i + 1)].join(' '), depth + 1, ctx) ? 'unknown' : null;
  }
  // 별칭 이름은 영문·숫자·- 뿐이다. 그 밖(fp4.js처럼 점이 든 낱말)은 명령이 아니라 보지 않는다
  if (!GIT_BUILTINS.has(sub)) return /^[A-Za-z0-9-]+$/.test(sub) ? 'unknown' : null;
  const rest = t.slice(i + 1);
  // 짧은 옵션 묶음(-uf, -rd)은 낱개로 푼다(결함 4). 값을 붙인 옵션(-ofoo)이 섞이면 엄한 쪽(강제 푸시 등)으로 틀린다
  const shorts = rest.filter((a) => /^-[A-Za-z0-9]{2,}$/.test(a)).join('');
  const has = (...flags) => rest.some((a) => flags.includes(a) || flags.some((f) => f.endsWith('=') && a.startsWith(f))) || flags.some((f) => /^-[A-Za-z0-9]$/.test(f) && shorts.includes(f[1]));
  const positional = rest.filter((a) => !a.startsWith('-'));
  // 다른 명령을 실행하는 하위 명령·옵션(U6): submodule foreach, bisect run, for-each-repo, difftool -x, --upload-pack 등
  if ((sub === 'submodule' && positional.includes('foreach')) || (sub === 'bisect' && positional[0] === 'run') || sub === 'for-each-repo') return 'unknown';
  if ((sub === 'difftool' && has('-x', '--extcmd', '--extcmd=')) || rest.some((a) => /^--(?:upload-pack|receive-pack|exec)(?:=|$)/.test(a))) return 'unknown';
  // git config로 실행 설정을 쓰거나 설정 파일을 편집기로 여는 것(X1)
  if (sub === 'config') {
    if (has('-e', '--edit') || positional[0] === 'edit') return 'unknown';
    const valueOpts = ['-f', '--file', '--blob', '--type', '--default', '--comment', '--value'];
    const args = rest.filter((a, j) => !a.startsWith('-') && !valueOpts.includes(rest[j - 1]));
    const kv = args[0] === 'set' ? args.slice(1) : args;
    if (kv[0] && EXEC_CONFIG.test(kv[0]) && kv.length >= 2) return 'unknown';
  }
  switch (sub) {
    case 'commit':
      return 'commit';
    case 'push':
      // 원격 브랜치를 지우는 push(--delete, :브랜치, --prune)는 브랜치 삭제로 본다
      if (has('--delete', '-d', '--prune') || positional.some((a) => a.startsWith(':'))) return 'delete-branch';
      if (has('-f', '--force', '--force-with-lease', '--force-with-lease=', '--force-if-includes', '--mirror') || positional.some((a) => a.startsWith('+'))) return 'force-push';
      return 'push';
    case 'merge':
    case 'rebase':
      return has('--abort', '--quit') ? null : sub; // 되돌리기는 잠그지 않는다
    case 'reset':
      return 'reset';
    case 'branch':
      if (has('-d', '-D', '--delete')) return 'delete-branch';
      if (has('-l', '--list', '-a', '--all', '-r', '--remotes', '--show-current', '-v', '-vv', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format=', '--sort=', '--column', '--no-column')) return null;
      return positional.length || has('-m', '-M', '-c', '-C', '--move', '--copy') ? 'branch' : null;
    case 'checkout':
      return has('-b', '-B', '--orphan') ? 'branch' : null;
    case 'switch':
      return has('-c', '-C', '--create', '--force-create', '--orphan') ? 'branch' : null;
    case 'tag':
      return has('-d', '--delete') ? 'tag-delete' : null;
    // S4 WT-05: 안에서 merge·rebase를 하는 pull, 커밋을 만드는 cherry-pick·revert·commit-tree, 가지를 직접 옮기는 update-ref·symbolic-ref
    case 'pull': {
      // 마지막 --rebase/--no-rebase가 이긴다. 없으면 -c pull.rebase(값 모름은 rebase로 본다). 설정 파일의 pull.rebase는 모른다(merge로 표시)
      const NO = /^(?:false|no|off|0)$/i;
      const last = rest.filter((a) => /^(?:-r|--rebase(?:=.*)?|--no-rebase)$/.test(a)).pop();
      if (last) return last === '--no-rebase' || NO.test(last.replace(/^--rebase=?/, '') || 'true') ? 'merge' : 'rebase';
      const cfg = config.filter((c) => /^pull\.rebase(?:=|$)/i.test(c)).pop();
      return cfg !== undefined && !NO.test(cfg.replace(/^pull\.rebase=?/i, '') || 'true') ? 'rebase' : 'merge';
    }
    case 'cherry-pick':
    case 'revert':
    case 'am':
      return has('--abort', '--quit', '--show-current-patch', '--show-current-patch=') ? null : 'commit';
    case 'commit-tree':
    case 'quiltimport':
      return 'commit';
    // 원격으로 올리는 저수준 명령
    case 'send-pack':
    case 'http-push':
      return 'push';
    // 커밋을 다시 쓰는 명령
    case 'filter-branch':
    case 'history':
    case 'replay':
      return 'rebase';
    // subtree add·merge·pull은 커밋을 만들고, push는 올린다. split은 --rejoin·-b일 때만 쓴다
    case 'subtree': {
      // 옵션이 동작 앞에 올 수 있다(git subtree -P x push …)
      const act = rest.find((a, j) => !a.startsWith('-') && !['-P', '--prefix', '-m', '--message', '-b', '--branch', '--onto', '--annotate'].includes(rest[j - 1]));
      if (act === 'push') return 'push';
      if (act === 'split') return has('--rejoin', '-b', '--branch', '--branch=') ? 'commit' : null;
      return ['add', 'merge', 'pull'].includes(act) ? 'commit' : null;
    }
    // fetch의 refspec 대상(x:main, +a:b)은 로컬 가지를 옮긴다. --stdin은 refspec을 안 보이게 받는다. 첫 위치 인자는 원격(URL에 : 가 든다)
    case 'fast-import':
      return 'branch';
    case 'fetch':
      if (has('--stdin') || rest.some((a, j) => /^--refmap=.*:/.test(a) || (a === '--refmap' && /:/.test(rest[j + 1] || ''))) || config.some((c) => /^remote\..*\.(?:fetch|mirror)(?:=|$)/i.test(c))) return 'branch';
      return !has('--multiple') && positional.slice(1).some((a) => /:./.test(a)) ? 'branch' : null;
    case 'update-ref':
      return has('-d') ? 'delete-branch' : 'branch';
    case 'symbolic-ref':
      if (has('-d', '--delete')) return 'delete-branch';
      return positional.length >= 2 ? 'branch' : null; // 인자 하나는 읽기
    // worktree add·remove·prune·move·unlock·repair: 다른 경로에 가드 없는 트리를 만들거나 다른 역할 트리를 지우거나 다시 잇는다. list·lock은 그대로
    case 'worktree':
      if (rest[0] === 'add') return has('-b', '-B', '--orphan') ? 'branch' : 'worktree';
      return ['remove', 'prune', 'move', 'unlock', 'repair'].includes(rest[0]) ? 'worktree' : null;
    default:
      return null;
  }
}

const mentionsProtected = (t) => {
  const c = t.replace(/\\/g, '/').toLowerCase();
  return PROTECTED.some((re) => re.test(c));
};

// 대상을 알 수 없는 인자(변수·명령 치환). 보호 경로가 나오는 명령에서 이런 대상에 쓰면 우회일 수 있어 막는다
const UNKNOWN_TARGET = /[$`%]/;
// 디렉터리 이동. 보호 경로(또는 알 수 없는 값)로 들어가면 이후 상대 경로 쓰기가 보호 경로에 쓰는 것이 된다
const CHDIR = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location', 'popd', 'pop-location']);
// 이동 대상이 명령에 안 보이는 이동(popd·Pop-Location, cd -·Set-Location -): 이전 상태에 기대므로 알 수 없는 곳으로 본다(커밋 세션 제안)
const HIDDEN_CHDIR = new Set(['popd', 'pop-location']);

function leadingTokens(seg) {
  let t = tokens(seg);
  for (;;) {
    // 붙여 쓴 대입($x=Remove-Item …): 오른쪽이 값이 아니면 프로그램으로 본다
    if (t.length && /^\$[\w:]+=[^"'@\d$=]/.test(t[0])) t = [t[0].replace(/^\$[\w:]+=/, ''), ...t.slice(1)];
    else if (t.length && (LEADING_KEYWORDS.has(t[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || /^\$\w+\s*=/.test(t[0]))) t = t.slice(1);
    // PowerShell 대입($x = …, = 이 따로 떨어진 토큰)과 앞의 형 변환([void] [IO.File]::…, [void][IO.File]::…)
    // 오른쪽이 값(문자열·숫자·변수·배열)이면 프로그램이 아니므로 떼지 않는다($i = "…\install.ps1")
    else if (t.length > 1 && /^\$[\w:]+$/.test(t[0]) && t[1] === '=' && !/\s=\s*["'@\d$]/.test(seg)) t = t.slice(2);
    else if (t.length && /^\[[\w.]+\](?:$|(?=\[))/.test(t[0])) t = [t[0].replace(/^\[[\w.]+\]/, ''), ...t.slice(1)].filter((a, j) => j || a);
    // 하위 셸 ( 에 붙은 프로그램((node <<'EOF' …)): ( 를 떼고 프로그램으로 본다(D-35)
    else if (t.length && /^\([^(]/.test(t[0])) t = [t[0].slice(1).replace(/^["']|["']$/g, ''), ...t.slice(1)];
    else {
      // 실행기(env·sudo·nohup·timeout·xargs·& …)와 그 옵션도 뗀다. 쓰기 판정·git 판정이 같은 규칙을 쓴다
      // xargs·Start-Process는 대상이 입력·인자 목록에서 오므로 여기서는 떼지 않는다(그 자체를 모르는 프로그램으로 본다)
      const r = stripRunners(t, true);
      if (r === t) return t;
      t = r;
    }
  }
}
// 조각 첫 토큰의 프로그램 이름(소문자, 확장자 뺌)
const progName = (t) => (t.length ? path.basename(t[0]).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '') : '');

// 보호 파일을 담은 폴더(.claude 자체, 승인 폴더, 설치 폴더). 이 안으로 이동하면 상대 경로로 보호 파일에 닿는다
const PROTECTED_DIR = /(?:^|\/)\.claude\/?$|wy-approvals|\.wy-tools/;
// .claude의 다른 하위 폴더(jobs·session-data·scratchpad 등). 거기서는 ..로 거슬러 올라갈 때만 보호 파일에 닿는다
const CLAUDE_SUBDIR = /(?:^|\/)\.claude\//;
const PARENT_REF = /(?:^|[\s/\\'"=])\.\.(?=[/\\\s'";&|)]|$)/;
// cd 대상 정규화: \ → /, ./·//·끝의 / 정리, ..는 접기(.claude/./ → .claude, .claude/jobs/.. → .claude)
const normDir = (a) => path.posix.normalize(a.replace(/\\/g, '/')).replace(/(.)\/+$/, '$1').toLowerCase();
// 보호 폴더·파일의 이름(경로 없이). 이것만 나와도 알 수 없는 대상으로의 쓰기는 막는다
const SOFT_NAMES = /wy-approvals|\.wy-tools|wy-ops(?:\.local)?\.json|settings\.local\.json/;

// 와일드카드(* ? [)가 든 경로는 실제로 펼쳐서 판단한다(cd ~/.cl*/wy-a*/… 같은 우회, 커밋 세션 검증에서 찾음)
const GLOB = /[*?[]/;

// 경로 한 조각의 와일드카드를 정규식으로. [ ]는 짝이 맞으면 글자 집합, 아니면 글자. 만들 수 없으면 null
function globRegExp(part) {
  const body = (keepClass) =>
    part
      .replace(keepClass ? /[.+^${}()|\\]/g : /[.+^${}()|\\[\]]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
  for (const keepClass of [true, false]) {
    try {
      return new RegExp(`^${body(keepClass)}$`, 'i');
    } catch {
      // 짝 없는 [ 등: 글자로 보고 다시
    }
  }
  return null;
}

// 경로 패턴을 파일 시스템에서 펼친다. 결과는 소문자·/ 구분자. 펼칠 수 없으면 빈 배열
function expandGlob(pattern, cwd) {
  let s = String(pattern).replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (s === '~' || s.startsWith('~/')) s = HOME + s.slice(1);
  let base;
  let parts;
  if (/^\/[a-z]\//i.test(s)) {
    base = `${s[1]}:/`; // Git Bash의 /c/… 형식
    parts = s.slice(3).split('/');
  } else if (/^[a-z]:\//i.test(s)) {
    base = s.slice(0, 3);
    parts = s.slice(3).split('/');
  } else if (s.startsWith('/')) {
    base = '/';
    parts = s.slice(1).split('/');
  } else {
    base = cwd || process.cwd();
    parts = s.split('/');
  }
  let bases = [base];
  for (const part of parts.filter((x) => x && x !== '.')) {
    const next = [];
    for (const b of bases) {
      if (part === '..' || !GLOB.test(part)) {
        next.push(path.join(b, part));
        continue;
      }
      const re = globRegExp(part);
      if (!re) continue; // 와일드카드로 볼 수 없는 조각(grep 정규식의 짝 없는 [ 등)은 펼치지 않는다
      let names = [];
      try {
        names = fs.readdirSync(b);
      } catch {
        // 읽을 수 없는 폴더는 건너뛴다
      }
      for (const n of names) if (re.test(n)) next.push(path.join(b, n));
    }
    bases = next.slice(0, 200);
    if (!bases.length) return [];
  }
  return bases.map((x) => x.replace(/\\/g, '/').toLowerCase());
}

// 임시 폴더에 만든 검증용 사본(git archive 등) 안의 프로젝트 설정 경로(KI-02). 이 프로젝트의 설정이 아니므로 보호 대상이 아니다.
// 절대 경로이고 임시 폴더 안·cwd 밖이며 ..·와일드카드·변수가 없을 때만. 승인 파일·설치본 경로는 해당 없음
const TMP = os.tmpdir().replace(/\\/g, '/');
const HOME = os.homedir().replace(/\\/g, '/');
const TMP_ROOTS = [TMP.toLowerCase(), '/tmp'];
// 한 번의 판단(writesApprovalFiles) 안에서 같은 인자를 여러 번 보므로 결과를 담아 둔다(판단마다 비운다)
const decisionMemo = new Map();
const memo = (fn) => (arg, cwd) => {
  const key = `${fn.name}\0${cwd}\0${arg}`;
  if (!decisionMemo.has(key)) decisionMemo.set(key, fn(arg, cwd));
  return decisionMemo.get(key);
};
const tempCopy = memo(isTempCopy);
const locate = memo(findPath);
function isTempCopy(arg, cwd) {
  const p = arg.replace(/\\/g, '/').toLowerCase().replace(/^\/([a-z])\//, '$1:/');
  if (!TMP_ROOTS.some((r) => p.startsWith(`${r}/`))) return false;
  // 쉼표·중괄호·세미콜론: PowerShell 배열·셸 펼치기로 다른 경로가 함께 들어올 수 있다
  if (UNKNOWN_TARGET.test(p) || GLOB.test(p) || /[,{};]/.test(p) || /(?:^|\/)\.\.(?:\/|$)/.test(p) || PROTECTED[0].test(p) || PROTECTED[1].test(p)) return false;
  const rel = path.relative(path.resolve(cwd || process.cwd()), path.resolve(p));
  if (!(rel.startsWith('..') || path.isAbsolute(rel))) return false;
  // 앞서 만든 링크(임시 폴더 → 프로젝트·홈)를 지나면 실제로는 보호 파일에 쓴다. 있는 가장 깊은 곳의 실제 경로가 임시 폴더 안이어야 한다
  const r = locate(arg, cwd).real; // 원래 대소문자로 찾는다(대소문자를 가리는 파일 시스템의 링크)
  const t = locate(TMP).real;
  if (!r || !t) return false;
  // 실제 경로가 작업 폴더(cwd) 안이어도 안 된다(임시 폴더 안의 프로젝트로 가는 링크)
  const c = locate(cwd || process.cwd()).real;
  if (c && (r === c || r.startsWith(`${c}/`))) return false;
  return r.startsWith(`${t}/`);
}

// 경로 인자를 절대 경로로 풀고, 있는 가장 깊은 곳(lstat: 깨진 링크도 '있음')의 실제 경로에 나머지를 붙인다(소문자·/).
// 실제 경로를 못 구하면(깨진 링크) real은 null. st는 경로 자체가 있을 때 그 lstat
function findPath(arg, cwd) {
  let p = arg.replace(/\\/g, '/');
  if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
  p = p.replace(/^\/([a-z])\//i, '$1:/');
  if (process.platform === 'win32' && /^\/tmp(?:\/|$)/i.test(p)) p = TMP + p.slice(4);
  const abs = path.resolve(cwd || process.cwd(), p);
  let q = abs;
  let st = null;
  for (;;) {
    try {
      st = fs.lstatSync(q);
      break;
    } catch {
      if (path.dirname(q) === q) break;
      q = path.dirname(q);
    }
  }
  let real = null;
  try {
    real = (fs.realpathSync.native(q) + abs.slice(q.length)).replace(/\\/g, '/').toLowerCase();
  } catch {}
  return { abs: abs.replace(/\\/g, '/').toLowerCase(), real, st: q === abs ? st : null };
}

// 앞 명령에서 만든 링크(KI-02): 쓰기 대상이 이미 있는 하드링크 파일(링크 수 2 이상 — 다른 이름을 알 수 없다)이거나,
// 링크를 지난 실제 경로가 보호 경로이면 막는다. 변수·와일드카드가 든 대상은 다른 검사가 본다. 임시 사본 예외는 실제 경로를 따로 본다
function linkedTarget(arg, cwd) {
  if (UNKNOWN_TARGET.test(arg) || GLOB.test(arg) || NULL_TARGET.test(arg) || !arg) return false;
  const x = locate(arg, cwd);
  if (x.st && x.st.isFile() && x.st.nlink > 1) return true;
  if (!x.real) return true; // 깨진 링크
  return x.real !== x.abs && !tempCopy(arg, cwd) && protectedTarget(x.real, cwd);
}
// 링크(심볼릭 링크·정션)를 지난 실제 경로가 보호 경로인지. 보호 이름이 명령에 안 나와도 본다(KI-08).
// 보호 이름이 없는 명령의 쓰기 대상에만 쓴다(옵션 인자 -…는 뺀다)
function linkIntoProtected(arg, cwd) {
  if (UNKNOWN_TARGET.test(arg) || GLOB.test(arg) || NULL_TARGET.test(arg) || !arg || arg.startsWith('-')) return false;
  const x = locate(arg, cwd);
  return !!x.real && x.real !== x.abs && !tempCopy(arg, cwd) && protectedTarget(x.real, cwd);
}

// 대상을 알 수 없는 인자: 변수·명령 치환, PowerShell 식((…), @(…)·@splat). 스위치 값의 PowerShell 상수(-Confirm:$false)는 값을 안다(D-35).
// -이름: 뒤에만 본다(bash 변수 true·null은 값을 모른다: true=$(…); rm "$true")
const PS_CONST = /(?<=(?:^|\s)-\w+:)\$(?:true|false|null)\b/gi;
const unknownArg = (a) => UNKNOWN_TARGET.test(a.replace(PS_CONST, '')) || /^[(@]/.test(a);

// 쓰기 대상이 보호 경로로 갈 수 있는지(직접 언급, 알 수 없는 값, 와일드카드를 펼친 결과, 링크)
function riskyTarget(arg, cwd) {
  if (linkedTarget(arg, cwd)) return true;
  if (tempCopy(arg, cwd)) return false;
  if (mentionsProtected(arg) || unknownArg(arg)) return true;
  // 상대 경로는 cwd 기준으로 풀어 본다(cwd가 .claude 안이면 wy-ops.json만 써도 보호 파일)
  if (!GLOB.test(arg) && !arg.startsWith('~') && mentionsProtected(path.resolve(cwd || process.cwd(), arg))) return true;
  if (!GLOB.test(arg)) return false;
  // 끝부분이 아무것도 펼치지 못하면(빈 폴더의 *) 상위 폴더로 올라가며 닿는 곳을 본다
  for (let p = arg.replace(/\\/g, '/'), i = 0; p && p !== '.' && p !== '/' && i < 20; p = path.posix.dirname(p), i++) {
    const hits = expandGlob(p, cwd);
    if (hits.length) return hits.some((x) => mentionsProtected(x) || mentionsProtected(`${x}/`));
  }
  return false;
}

// 펼칠 수 없는 와일드카드(아직 없는 파일, 이 PC에 없는 폴더)도 보호 경로를 가리킬 수 있는지: 조각마다 보호 이름과 맞춰 보고
// 맞는 이름으로 바꾼 경로가 보호 경로이면 true(~/.cl?ude/wy-a*/p/decisions/new.json). 글자가 3개 미만인 조각(*, a*)은 맞추지 않는다.
// 셸 -c 문자열처럼 공백 든 토큰은 나눠서 본다
const GLOB_NAMES = ['.claude', 'wy-approvals', '.wy-tools', 'wy-ops.json', 'wy-ops.local.json', 'settings.local.json', 'decisions', 'used', 'sessions', 'config.json', 'message-blocks.log', '.trust'];
function globNamesProtected(arg) {
  return arg.split(/\s+/).some((p) => {
    if (!GLOB.test(p)) return false;
    const named = p
      .replace(/\\/g, '/')
      .split('/')
      .map((part) => {
        if (!GLOB.test(part) || part.replace(/\[[^\]]*\]|[*?]/g, '').length < 3) return part;
        const re = globRegExp(part);
        return (re && GLOB_NAMES.find((n) => re.test(n))) || part;
      })
      .join('/');
    return mentionsProtected(named) || mentionsProtected(`${named}/`);
  });
}

// sed가 고치는 파일 인자. 스크립트(-e 값, 없으면 첫 인자)는 대상이 아니다 — 정규식의 $ [ 를 알 수 없는 대상으로 보던 오탐
function sedFiles(args) {
  const files = [];
  let script = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') {
      script = true;
      i++;
    } else if (/^--(?:expression|file)=/.test(a)) script = true;
    else if (/^-/.test(a)) continue;
    else if (!script) script = true;
    else files.push(a);
  }
  return files;
}

// 복사 프로그램이 쓰는 대상(원본은 읽기만 한다). 대상을 확실히 알 수 없으면 null(조각 전체로 판단) — KI-02 사본에 설정 복사
const COPIERS = new Set(['cp', 'copy', 'copy-item', 'cpi']);
const COPY_ITEM_VALUE = ['path', 'literalpath', 'filter', 'include', 'exclude'];
const COPY_ITEM_SWITCH = ['recurse', 'force', 'container', 'passthru'];
function copyTarget(prog, args) {
  if (prog === 'cp' || prog === 'copy') {
    const pos = args.filter((a) => !a.startsWith('-') && !(prog === 'copy' && /^\/-?[a-z]$/i.test(a)));
    // -t 폴더: 원본마다 '폴더/원본 이름'이 대상
    const t = args.findIndex((a) => /^--target-directory|^-[^-]*t/.test(a));
    if (t >= 0) {
      const m = /^(?:--target-directory=|-[^-t]*t)(.+)$/.exec(args[t]);
      const dir = m ? m[1] : args[t + 1];
      if (!dir || dir.startsWith('-')) return null;
      return pos.filter((a) => a !== dir).map((a) => `${dir.replace(/[\\/]+$/, '')}/${path.basename(a)}`);
    }
    // 대상이 폴더일 수도 있으니 '대상/원본 이름'도 본다(cp wy-ops.json .claude/)
    const dest = pos[pos.length - 1];
    return pos.length >= 2 ? [dest, ...pos.slice(0, -1).map((a) => `${dest.replace(/[\\/]+$/, '')}/${path.basename(a)}`)] : null;
  }
  const pos = [];
  let dest = null;
  for (let i = 0; i < args.length; i++) {
    const f = /^-([A-Za-z]+)(:?)([\s\S]*)$/.exec(args[i]);
    if (!f) {
      pos.push(args[i]);
      continue;
    }
    const name = f[1].toLowerCase();
    const value = () => (f[2] ? f[3] : args[++i]);
    if (name.length >= 4 && 'destination'.startsWith(name)) dest = value();
    else if (COPY_ITEM_VALUE.includes(name)) {
      if (name === 'path' || name === 'literalpath') pos.unshift(value());
      else value();
    } else if (!COPY_ITEM_SWITCH.includes(name)) return null;
  }
  if (dest === null) dest = pos[1];
  if (dest === undefined || dest === null) return null;
  // 쉼표 목록은 원본(pos[0] 한 토큰 a,b)에서만 푼다. 대상 목록·떨어진 목록(a, b)·남는 인자는 모르므로 조각 전체로 본다
  if (dest.includes(',') || pos.length > 2 || /,$/.test(pos[0] || '')) return null;
  const srcs = (pos[0] || '').split(',').filter(Boolean);
  return [dest, ...srcs.map((a) => `${dest.replace(/[\\/]+$/, '')}/${path.basename(a)}`)];
}

// 명령 안에 보호 폴더(또는 알 수 없는 곳)로 들어가는 이동이 있는지. known이면 알 수 없는 곳은 빼고 보호 폴더로 가는 것만
function movesIntoProtected(command, cwd, known = false) {
  const segs = allSegments(command);
  return segs.some((seg, i) => {
    const t = leadingTokens(seg);
    const prog = t.length ? path.basename(t[0]).toLowerCase() : '';
    if (!CHDIR.has(prog)) return false;
    // 맨 끝의 popd(pushd … && popd 되돌리기)는 뒤에 쓰기가 없으므로 보지 않는다
    if (HIDDEN_CHDIR.has(prog) || t.slice(1).includes('-')) return !known && i < segs.length - 1;
    const args = t.slice(1).filter((a) => !/^-/.test(a));
    const up = PARENT_REF.test(command);
    // 요청 폴더(requests/) 안으로의 이동은 통과(..로 거슬러 오르지 않을 때). 카드를 임시 이름으로 쓰고 rename하는 절차(0.8.0 오탐 수정)
    const into = (p) => (PROTECTED_DIR.test(p) && (up || !REQUESTS_PATH.test(p))) || (up && CLAUDE_SUBDIR.test(p));
    return args.some((a) => {
      if (into(a.replace(/\\/g, '/').toLowerCase()) || into(normDir(a))) return true;
      if (unknownArg(a)) return !known;
      // 링크를 지나 보호 폴더로 들어가는 이동(앞 명령에서 만든 링크)
      if (!GLOB.test(a)) {
        const x = locate(a, cwd);
        if ((!x.real && !known) || (x.real && x.real !== x.abs && into(x.real))) return true;
      }
      if (!GLOB.test(a) && !a.startsWith('~') && into(normDir(path.resolve(cwd || process.cwd(), a)))) return true; // cwd 기준(.claude/jobs에서 cd ..)
      if (!GLOB.test(a)) return false;
      const hits = expandGlob(a, cwd);
      return (!hits.length && !known) || hits.some(into); // 펼칠 수 없으면 알 수 없는 곳으로 본다
    });
  });
}

// $이름·${이름} 읽기 정규식(이름마다 한 번 만든다). env:은 PowerShell이라 대소문자를 가리지 않는다
const VAR_READ = new Map();
function varRead(name) {
  if (!VAR_READ.has(name)) {
    const n = name.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
    VAR_READ.set(name, new RegExp(`\\$\\{${n}\\}|\\$${n}(?![\\w:])`, name.startsWith('env:') ? 'gi' : 'g'));
  }
  return VAR_READ.get(name);
}
// 임시 폴더 변수 이름이 $로 읽는 것 말고 나오는 곳(+=·printf -v·eval 등)
const TEMP_NAME_USE = /(?<![$\w{:])(TEMP|TMP|TMPDIR)\b|\$\{?(TEMP|TMP|TMPDIR)\}?\s*[^\s\w]?=(?!=)/g;
// PowerShell Join-Path(위치 인자 둘, 또는 -Path·-ChildPath). 대입($S = Join-Path …)은 그 문장이 거기서 끝날 때만, 식((Join-Path …))은 인자 하나일 때만
const JOIN_ASSIGN = /(?:^|[;\n]\s*)\$([A-Za-z_]\w*)\s*=\s*(?:\(\s*Join-Path\s+([^;&|\n()]*)\)|Join-Path\s+([^;&|\n()]*?))\s*(?=$|[;\n])/gi;
const JOIN_EXPR = /(?<=^|[\s;])\(\s*Join-Path\s+([^;&|\n()]*)\)(?=$|[\s;])/gi;

// 같은 명령 안에서 글자 그대로 정한 변수(S=/tmp/x, export S="…", $S = '…')와 홈 변수($HOME·${HOME}·$USERPROFILE·$env:USERPROFILE)를
// 값으로 바꾼다. 알 수 없는 대상으로 보던 오탐(S=/tmp/x; rm -rf $S)을 줄이고, 보호 경로를 변수에 담은 우회는 값이 드러나 잡힌다
// 임시 폴더 변수($TEMP·$TMP·$TMPDIR·$env:TEMP·$env:TMP)도 값으로 바꾼다(KI-02: 사본 폴더로 이동·복사). 명령에서 다시 정하면 알 수 없는 값으로 둔다.
// 큰따옴표 값 안의 변수는 아는 값으로 풀고, 풀리지 않는 $가 남으면 알 수 없는 값으로 둔다($S="$env:TEMP\c1")
// Join-Path의 인자가 모두 아는 값이면 이어 붙인 경로로 본다($S = Join-Path $env:TEMP c1, KI-02). S=$(mktemp -d)는 임시 폴더 안 새 폴더로 본다
function resolveVars(command) {
  const vars = new Map([['HOME', HOME], ['USERPROFILE', HOME], ['env:USERPROFILE', HOME], ['TEMP', TMP], ['TMP', TMP], ['TMPDIR', TMP], ['env:TEMP', TMP], ['env:TMP', TMP]]);
  const unq = (v) => v.replace(/^(["'])(.*)\1$/, '$2');
  // 값을 다시 정할 수 있는 변수(read·for·mapfile·getopts, 명령 치환 대입, 서로 다른 값 두 번)는 바꾸지 않는다 → 알 수 없는 대상으로 남는다
  const unsafe = new Set();
  for (const m of command.matchAll(/\b(?:read|mapfile|readarray)\b((?:\s+-\S+(?:\s+\S+)?)*)((?:\s+[A-Za-z_]\w*)+)/g)) for (const n of m[2].trim().split(/\s+/)) unsafe.add(n);
  for (const m of command.matchAll(/\b(?:for|select)\s+([A-Za-z_]\w*)\s+in\b|\bgetopts\s+\S+\s+([A-Za-z_]\w*)|\bforeach\s*\(\s*\$([A-Za-z_]\w*)/gi)) unsafe.add(m[1] || m[2] || m[3]);
  // 명령 치환 대입은 모르는 값. 단 S=$(mktemp -d)와 $S = (Join-Path …)는 아래에서 따로 본다
  // (Join-Path …) 대입은 그 문장 전체가 JOIN_ASSIGN에 맞을 때만 뺀다(뒤에 + … 등이 붙으면 모르는 값)
  const joins = [...command.matchAll(JOIN_ASSIGN)];
  for (const m of command.matchAll(/(?:^|[;&|\n(\s])(?:export\s+|local\s+|declare\s+)?\$?([A-Za-z_]\w*)\s*\+?=\s*(?=[$`(])(?!\$\(mktemp -d\)(?:$|[\s;&|]))/g)) {
    const end = m.index + m[0].length;
    if (!joins.some((j) => j[1] === m[1] && j.index <= end && end < j.index + j[0].length)) unsafe.add(m[1]);
  }
  // PowerShell 변수 이름은 대소문자를 가리지 않는다($S·$s). 대소문자만 다른 이름이 둘 이상이면 모두 모르는 값으로 둔다
  const set = (n, v) => {
    for (const k of vars.keys()) if (k !== n && k.toLowerCase() === n.toLowerCase()) unsafe.add(k).add(n);
    return vars.has(n) && !['HOME', 'USERPROFILE', 'env:USERPROFILE'].includes(n) && vars.get(n) !== v ? unsafe.add(n) : vars.set(n, v);
  };
  // PowerShell 환경 변수를 명령에서 바꾸면($env:TEMP = …, Set-Item env:…, SetEnvironmentVariable) 그 값은 모른다
  const envNames = [...vars.keys()].filter((n) => n.startsWith('env:'));
  // 임시 폴더 값은 틀리면 '안전' 쪽으로 틀리므로, $로 읽는 것 말고 이름이 나오면(+=·printf -v·eval·'env:TEMP' 등) 모른다고 본다
  for (const m of command.matchAll(/\$env:(\w+)\s*[^\s\w]?=(?!=)|(?<![$\w])env:(\w+)/gi)) for (const n of envNames) if (n.toLowerCase() === `env:${m[1] || m[2]}`.toLowerCase()) unsafe.add(n);
  for (const m of command.matchAll(TEMP_NAME_USE)) unsafe.add(m[1] || m[2]);
  if (/SetEnvironmentVariable|\b(?:set-item|new-item|si|ni)\s+(?:-\w+\s+)*['"]?env:/i.test(command)) for (const n of envNames) unsafe.add(n);
  const subst = (s) => {
    for (const [name, value] of vars) if (!unsafe.has(name) && s.includes('$')) s = s.replace(varRead(name), () => value);
    return s;
  };
  const setQuoted = (n, raw) => {
    const v = raw.startsWith('"') ? subst(unq(raw)) : unq(raw);
    if (raw.startsWith('"') && v.includes('$')) unsafe.add(n);
    else set(n, v);
  };
  for (const m of command.matchAll(/(?:^|[;&|\n(]\s*)(?:export\s+|local\s+|declare\s+)?([A-Za-z_]\w*)=("[^"`]*"|'[^']*'|[^\s;&|$`'"()]+)/g)) setQuoted(m[1], m[2]);
  for (const m of command.matchAll(/(?:^|[;&|\n]\s*)\$([A-Za-z_]\w*)\s*=\s*("[^"`]*"|'[^']*')/g)) setQuoted(m[1], m[2]);
  // mktemp -d는 $TMPDIR(없으면 /tmp) 아래 새 폴더를 만든다. TMPDIR·PATH를 바꾸거나 mktemp를 함수·별칭으로 다시 정하는 명령이면 모른다
  const fakeMktemp = unsafe.has('TMPDIR') || /\bPATH\s*\+?=|\b(?:function|alias)\s+mktemp\b|\bmktemp\s*\(\)/.test(command);
  for (const m of command.matchAll(/(?:^|[;&|\n(]\s*)(?:export\s+|local\s+)?([A-Za-z_]\w*)=\$\(mktemp -d\)(?=$|[\s;&|])/g)) (fakeMktemp ? unsafe.add(m[1]) : set(m[1], `${TMP}/wy-mktemp-0`));
  // Join-Path 인자: 작은따옴표는 글자 그대로, 나머지는 아는 변수를 푼다. 풀리지 않는 값·식·배열(,)이면 null
  const joinPath = (args) => {
    const t = args.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const named = t.length === 4 && /^-path$/i.test(t[0]) && /^-childpath$/i.test(t[2]);
    if (!(named || (t.length === 2 && !t.some((a) => a.startsWith('-'))))) return null;
    const v = (named ? [t[1], t[3]] : t).map((a) => (a.startsWith("'") ? unq(a) : subst(unq(a))));
    if (v.some((a) => !a || /[$`(),;{}@'"]/.test(a))) return null;
    return `${v[0].replace(/[\\/]+$/, '')}/${v[1].replace(/^[\\/]+/, '')}`;
  };
  for (const m of joins) {
    const v = joinPath(m[2] !== undefined ? m[2] : m[3]);
    if (v === null) unsafe.add(m[1]);
    else set(m[1], v);
  }
  // 대소문자만 다른 이름도 함께 지운다(PowerShell)
  const unknown = new Set([...unsafe].map((n) => n.toLowerCase()));
  for (const n of [...vars.keys()]) if (unknown.has(n.toLowerCase())) vars.delete(n);
  // PowerShell 대입문 왼쪽($i = …)은 바꾸지 않는다. 값(설치본 install.ps1 경로)이 프로그램 자리에 와서 쓰기 프로그램(install)으로 보던 오탐(KI-08)
  const lhs = command.replace(JOIN_EXPR, (all, a) => joinPath(a) || all).replace(/(^|[;&|\n(]\s*)\$([A-Za-z_]\w*)(?=\s*=(?!=))/g, '$1\u0001$2');
  return subst(lhs).replace(/\u0001/g, () => '$');
}

// PowerShell 식 인자(KI-08 A3): 글자끼리 이어 붙인 식(('a' + "b"))을 글자 하나로 접는다. 큰따옴표 안에 풀리지 않은 $·`가 있으면 접지 않는다
const CONCAT = /\(\s*((?:'[^']*'|"[^"$`]*")(?:\s*\+\s*(?:'[^']*'|"[^"$`]*"))+)\s*\)/g;
function foldConcat(command) {
  for (let prev = ''; prev !== command; ) {
    prev = command;
    command = command.replace(CONCAT, (m, body, off, s) => {
      // 인자 자리에서만 접는다. 조각 맨 앞의 ( )는 bash 하위 셸이라 첫 글자가 프로그램이다(접으면 프로그램이 사라진다)
      const before = s.slice(0, off).trimEnd();
      if (!before || /[;|&({\n]$/.test(before)) return m;
      const v = body.match(/'[^']*'|"[^"]*"/g).map((x) => x.slice(1, -1)).join('');
      if (v.includes("'") && v.includes('"')) return m; // 두 따옴표가 다 들면 감쌀 수 없다(뒤 조각 나누기가 깨진다)
      return v.includes("'") ? `"${v}"` : `'${v}'`;
    });
  }
  return command;
}
// 접을 수 없는 식이 쓰기 대상일 때 보호 이름의 조각으로 볼 글자(휴리스틱: 이것도 없이 쪼갠 이름은 못 잡는다)
const NAME_PIECES = /claude|\.cl|aude|wy-|approv|decision|\.trust|settings|tools|ops/i;

// ── 0.8.0 오탐 수정: here-doc 본문과 코드의 쓰기 대상 ──────────────────────────────
// 요청 폴더(requests/)는 세션이 카드를 쓰는 곳이라 보호 대상이 아니다(임시 이름 .part로 쓴 뒤 rename — README)
const REQUESTS_PATH = /wy-approvals\/(?:[^/\s"'`]+\/)?requests(?:\/|$)/;
// 본문을 명령으로 보지 않는 here-doc 소비자: 데이터를 받는 것(cat·tee)과 코드 인터프리터(본문은 그 코드로 따로 본다)
const HEREDOC_DATA = new Set(['cat', 'tee']);
const CODE_INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'perl', 'ruby', 'deno', 'bun']);
// 데이터 본문을 쓴 파일을 실행할 수 없는 프로그램(KI-02: 본문에 보호 이름이 있어도 통과)
const HEREDOC_SAFE = new Set(['cat', 'tee', 'mkdir', 'ls', 'echo', 'cd', 'grep', 'rg', 'head', 'tail', 'wc', 'diff', 'test', 'true', 'rm', 'mv', 'cp', 'chmod', 'touch']);

// 이 줄에서 here-doc을 여는 연산자 <<를 찾는다(S3 관문). 따옴표 안(여러 줄에 걸친 것 포함)·<<<·# 주석 뒤는 아니다.
// "$(…)" 안은 따옴표 밖으로 본다. 줄 끝에 따옴표가 열려 있으면 본문이 어디서 시작할지 몰라 here-doc으로 보지 않는다.
// stack은 줄 사이에 이어 쓰는 따옴표·괄호 상태(' " ( )다. 돌려줌: { at, m }(m은 <<(-?)(['"]?)(구분자)) 또는 null
function heredocStart(line, stack) {
  let found = null;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    const top = stack[stack.length - 1];
    if (top === "'") {
      if (ch === "'") stack.pop();
    } else if (top === '"') {
      if (ch === '\\' || ch === '`') k++;
      else if (ch === '"') stack.pop();
      else if (ch === '$' && line[k + 1] === '(') stack.push('('), k++;
    } else if (ch === '\\' || ch === '`') k++;
    else if (ch === "'" || ch === '"') stack.push(ch);
    else if (ch === '(') stack.push('(');
    else if (ch === ')') {
      if (top === '(') stack.pop();
    } else if (ch === '#' && (k === 0 || /[\s;&|(]/.test(line[k - 1]))) break;
    else if (ch === '<' && line[k + 1] === '<') {
      if (line[k + 2] === '<') k += 2;
      else {
        const m = !found && line.slice(k).match(/^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/);
        if (m) found = { at: k, m };
        k++;
      }
    }
  }
  const top = stack[stack.length - 1];
  return top === "'" || top === '"' ? null : found;
}

// here-doc 본문을 떼어 낸다. 셸(bash 등)이나 모르는 프로그램의 본문은 명령이므로 그대로 둔다.
//   돌려줌 { command: 본문을 뺀 명령, bodies: here-doc 머리 순서대로 본문(그대로 둔 것은 null), heads: 그 머리의 { at: command 안 << 위치, prog: 본문을 받는 프로그램 },
//           code: 데이터 본문(cat·tee)만 뺀 명령 — 실행되지 않는 데이터의 ?·[·*를 와일드카드로 보지 않게(2026-10-10 pm 오탐) }
//   gitMsg: 커밋 메시지를 here-doc으로 받는 git commit·merge(-F - <<'EOF')의 본문도 뗀다(evaluate의 잠금 판정용). 본문은 git이 메시지로 읽을 뿐 셸이 실행하지 않는다
//   dataToo: false면 cat·tee·인터프리터 본문은 떼지 않는다(그 본문을 실행할 수 있는 명령일 때)
function splitHeredocs(command, gitMsg = false, dataToo = true) {
  const lines = command.split('\n');
  const out = [];
  const code = [];
  const bodies = [];
  const heads = [];
  const data = [];
  const codeBodies = [];
  const codeProgs = [];
  const stack = [];
  let pos = 0; // out.join('\n')에서 다음 줄이 시작하는 위치
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = pos;
    out.push(line);
    code.push(line);
    pos += line.length + 1;
    const h = heredocStart(line, stack);
    if (!h) continue;
    const { at, m } = h;
    const before = segments(line.slice(0, at)).pop() || '';
    const t = leadingTokens(before);
    const prog = progBase(t[0]);
    heads.push({ at: lineStart + at, prog });
    const end = lines.findIndex((l, j) => j > i && (m[1] ? l.replace(/^\t+/, '') : l) === m[3]);
    // cat <<EOF | bash처럼 데이터 본문을 넘겨받는 프로그램이 안전 목록 밖이면 실행될 수 있어 명령으로 둔다
    //   앞에 낱말을 붙여 나눈다: 머리 뒤 남은 글(> 파일)이 첫 조각, 파이프 뒤 프로그램이 다음 조각(' | sed e'의 빈 첫 조각이 버려지지 않게)
    const piped = segments('x' + line.slice(at + m[0].length)).slice(1).some((sg) => !HEREDOC_SAFE.has(path.basename(leadingTokens(sg)[0] || '').toLowerCase().replace(/\.exe$/, '')));
    const isData = dataToo && ((HEREDOC_DATA.has(prog) && !piped) || CODE_INTERPRETERS.has(prog));
    const isMsg = gitMsg && progName(stripRunners(t)) === 'git' && ['commit', 'merge'].includes(classify(before));
    // 따옴표 없는 구분자(<<EOF)의 본문은 셸이 $(…)·백틱을 먼저 실행하므로 명령으로 둔다
    if (end < 0 || !(isData || isMsg) || expandsBody(m, lines.slice(i + 1, end))) {
      bodies.push(null);
      // 남긴 본문은 명령으로 판정하되 따옴표 상태는 따라가지 않는다(본문의 ' 하나가 뒤 줄의 상태를 바꾸지 않게)
      if (end > i) {
        out.push(...lines.slice(i + 1, end + 1));
        pos += lines.slice(i + 1, end + 1).join('\n').length + 1;
        code.push(...lines.slice(i + 1, end + 1));
        i = end;
      }
      continue;
    }
    bodies.push(lines.slice(i + 1, end).join('\n'));
    if (!isData) code.push(...lines.slice(i + 1, end));
    else if (CODE_INTERPRETERS.has(prog)) {
      code.push(...lines.slice(i + 1, end));
      codeBodies.push(bodies[bodies.length - 1]);
      codeProgs.push(prog);
    } else data.push(bodies[bodies.length - 1]);
    i = end;
  }
  return { command: out.join('\n'), bodies, heads, code: code.join('\n'), data, codeBodies, codeProgs };
}
const progBase = (p) => (p ? path.basename(p).toLowerCase().replace(/\.exe$/, '') : '');
// PowerShell에는 here-doc이 없다(<<는 글자일 뿐, 백슬래시도 이스케이프가 아니다). 본문을 떼지 않는다(S3 관문 결함 2)
const noHeredocs = (command) => ({ command, bodies: [], heads: [], code: command, data: [], codeBodies: [], codeProgs: [] });
const expandsBody = (m, body) => !m[2] && body.some((l) => /\$\(|`/.test(l));

// ── 오탐 수정(2026-10-10 pm): 설치본 CLI의 읽기 전용 하위 명령, PowerShell 내용 쓰기의 데이터 ──────────
// 설치본 경로가 명령에 있어도 읽기 전용 하위 명령(doctor·도움말)은 통과. deploy·gen·host·connect 등 나머지는 그대로 본다(허용 목록).
//   powershell [-NoProfile …] -File <…>/install.ps1 doctor, & <…>/install.ps1 doctor, node <…>/lib/install.js doctor
// --yes는 빠진 도구를 설치하므로 허용 인자에 넣지 않는다. 리디렉션은 버리는 것(2>&1, >$null 등)만
const READONLY_SUBCMDS = new Set(['doctor', 'help', '--help', '-h', 'version', '--version']);
const READONLY_FLAGS = new Set(['--json', '--todos', '--skip-install']);
const NULL_REDIRECT = /^\d?>{1,2}(?:&\d|\/dev\/null|\$null|nul)$/i;
function readOnlyCli(seg) {
  const t0 = leadingTokens(seg);
  if (t0.some((a) => /[`<>]|\$\(/.test(a) && !NULL_REDIRECT.test(a))) return false;
  let t = t0.filter((a) => !NULL_REDIRECT.test(a));
  const prog = t.length ? path.basename(t[0].replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '') : '';
  let want = 'install.ps1';
  if (prog === 'powershell' || prog === 'pwsh') {
    let i = 1;
    for (; i < t.length && !/^-(?:file|f)$/i.test(t[i]); i++) {
      if (/^-(?:executionpolicy|ep|ex|windowstyle|w)$/i.test(t[i])) i++;
      else if (!/^-(?:noprofile|nop|noninteractive|noni|nologo)$/i.test(t[i])) return false;
    }
    t = t.slice(i + 1);
  } else if (prog === 'node') {
    want = 'install.js';
    t = t.slice(1);
  }
  const script = (t[0] || '').replace(/\\/g, '/').toLowerCase();
  if (path.posix.basename(script) !== want || (want === 'install.js' && !/(?:^|\/)lib\/install\.js$/.test(script))) return false;
  const args = t.slice(1).map((a) => a.toLowerCase());
  if (!args.length || !READONLY_SUBCMDS.has(args[0])) return false;
  // --project <폴더>: 점검할 프로젝트(doctor는 읽기만 한다, KI-02 다른 프로젝트 점검)
  // 값은 플래그(-…)·PowerShell 식(( ) $ @)이 아니어야 한다(doctor --project --yes 우회)
  const folder = (v) => v && !/^-|[()$@]/.test(v);
  for (let i = 1; i < args.length; i++) {
    if (args[0] === 'doctor' && args[i] === '--project' && folder(args[i + 1])) i++;
    else if (!READONLY_FLAGS.has(args[i]) && !(args[0] === 'doctor' && args[i].startsWith('--project=') && folder(args[i].slice(10)))) return false;
  }
  return true;
}
// 읽기 전용 CLI 조각을 아무것도 하지 않는 명령으로 바꾼다(나머지 조각은 그대로 판단). 블록 안 조각(A1)도.
// 조각 경계에서만 바꾼다(같은 글자로 시작하는 다른 조각 '… doctor --yes'의 앞부분을 바꾸지 않게)
function neutralizeReadOnlyCli(command) {
  let out = command;
  for (const seg of allSegments(command)) {
    if (!readOnlyCli(seg)) continue;
    const re = new RegExp(`(^|[;\\n|&({\`]\\s*)${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s*(?:$|[;\\n|&)}\`]))`);
    out = out.replace(re, (m, a) => `${a}true`);
  }
  return out;
}

// PowerShell 내용 쓰기 명령: 대상은 -Path·첫 위치 인자, 내용(-Value·-InputObject·둘째 위치 인자)은 데이터다.
// 문서에 덧붙이는 내용에 보호 파일 이름이 들어 있어도 대상만 본다(Add-Content docs/진행현황.md "… wy-ops.json …")
const CONTENT_WRITERS = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file']);
const PS_SWITCHES = new Set(['nonewline', 'force', 'passthru', 'append', 'noclobber', 'whatif', 'confirm', 'asbytestream']);
function contentArgs(args) {
  const target = [];
  const data = [];
  let pos = 0;
  for (let i = 0; i < args.length; i++) {
    const f = /^-([A-Za-z]+)(:?)([\s\S]*)$/.exec(args[i]);
    if (!f) {
      (pos++ === 0 ? target : data).push(args[i]);
      continue;
    }
    const name = f[1].toLowerCase();
    const isData = name.length >= 2 && ('value'.startsWith(name) || 'inputobject'.startsWith(name));
    if (f[2]) (isData ? data : target).push(f[3]);
    else if (!PS_SWITCHES.has(name) && i + 1 < args.length) (isData ? data : target).push(args[++i]);
  }
  return { target, data };
}

// 쓰기 프로그램이 쓰는 대상을 확실히 알면 그 목록(내용 쓰기의 대상 인자, 복사의 대상), 아니면 null(모든 인자로 판단)
const writeArgs = (prog, rest, seg) => (CONTENT_WRITERS.has(prog) && !/@['"]\s*\n/.test(seg) ? contentArgs(rest).target : COPIERS.has(prog) ? copyTarget(prog, rest) : null);

// PowerShell here-string(@'…'@, @"…"@)은 글자 그대로의 값이다. 내용 쓰기 명령의 내용 자리(-Value·둘째 위치 인자·파이프 입력)에
// 쓰인 것만 빈 문자열로 바꿔 본문의 보호 이름·> 를 명령으로 보지 않는다. 변수에 담거나 경로·코드로 쓰일 수 있는 자리는 그대로 둔다
const PS_HERE = /@(['"])[ \t]*\r?\n[\s\S]*?\r?\n\1@/g;
function dataHereStrings(command) {
  const found = [];
  const ph = command.replace(PS_HERE, (m) => `__WYHS${found.push(m) - 1}__`);
  if (!found.length) return command;
  const safe = new Set();
  for (const seg of segments(ph)) {
    const t = leadingTokens(seg);
    if (!t.length || !CONTENT_WRITERS.has(path.basename(t[0]).toLowerCase())) continue;
    for (const a of contentArgs(t.slice(1)).data) for (const m of a.matchAll(/__WYHS(\d+)__/g)) safe.add(Number(m[1]));
  }
  for (const m of ph.matchAll(/(?:^|[;\n(]|&&|\|\|)\s*__WYHS(\d+)__\s*\|(?!\|)\s*([\w-]+)/g)) if (CONTENT_WRITERS.has(m[2].toLowerCase())) safe.add(Number(m[1]));
  return ph.replace(/__WYHS(\d+)__/g, (_, i) => (safe.has(Number(i)) ? "''" : found[Number(i)]));
}

// s[i]의 여는 괄호에 맞는 닫는 괄호 위치(따옴표 안은 건너뜀). 없으면 -1
function closeParen(s, i) {
  let depth = 0;
  let q = '';
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (c === '\\') j++;
      else if (c === q) q = '';
    } else if (c === '"' || c === "'" || c === '`') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return j;
  }
  return -1;
}

// s[0..end) 안에서 닫히지 않은 ( { 중 마지막 위치(따옴표 안은 건너뜀). 없으면 -1
function unclosedBefore(s, end) {
  const open = [];
  let q = '';
  for (let j = 0; j < end; j++) {
    const c = s[j];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '{') open.push(j);
    else if (c === ')' || c === '}') open.pop();
  }
  return open.length ? open[open.length - 1] : -1;
}

// 괄호·따옴표 밖의 구분자로 나눈다
function splitTop(s, seps) {
  const out = [];
  let cur = '';
  let depth = 0;
  let q = '';
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (q) {
      cur += c;
      if (c === '\\') cur += s[++j] || '';
      else if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (depth === 0 && seps.includes(c)) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

// 코드 안에서 글자 그대로 정한 변수(const d = …, d = …). 다시 정하거나(+= 등, 다른 값) 값이 여러 개면 모르는 값으로 둔다
function definitions(code) {
  const defs = new Map();
  const bad = new Set();
  for (const m of code.matchAll(/(?:^|[;\n{(]|\b(?:const|let|var)\s)\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) {
    const value = splitTop(code.slice(m.index + m[0].length), ';\n,')[0];
    if (defs.has(m[1]) && defs.get(m[1]) !== value) bad.add(m[1]);
    defs.set(m[1], value);
  }
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*(?:[-+*/%|&^]|\?\?|\|\||&&|\/\/)=/g)) bad.add(m[1]);
  for (const n of bad) defs.delete(n);
  return defs;
}

const HOME_EXPR = /^(?:(?:require\(\s*['"](?:node:)?os['"]\s*\)|os)\.homedir\(\)|homedir\(\)|Path\.home\(\)|os\.path\.expanduser\(\s*['"]~['"]\s*\)|process\.env\.(?:HOME|USERPROFILE)|process\.env\[\s*['"](?:HOME|USERPROFILE)['"]\s*\]|os\.environ\[\s*['"](?:HOME|USERPROFILE)['"]\s*\]|os\.(?:environ\.get|getenv)\(\s*['"](?:HOME|USERPROFILE)['"]\s*\))$/;
const CWD_EXPR = /^(?:process\.cwd\(\)|os\.getcwd\(\)|Path\.cwd\(\)|__dirname)$/;
const JOIN_CALL = /^(?:(?:require\(\s*['"](?:node:)?path['"]\s*\)|path)(?:\.posix|\.win32)?\.(?:join|resolve)|os\.path\.join|Path|PurePath|PurePosixPath|PureWindowsPath)\s*\(/;
const SAME_CALL = /^(?:String|str|os\.path\.(?:expanduser|abspath|normpath|realpath)|(?:path(?:\.posix|\.win32)?)\.normalize)\s*\(/;

// 경로 식을 글자로 푼다(문자열·+·/·path.join·Path·홈·변수). 풀 수 없으면 null
function evalPath(expr, defs, depth = 0) {
  if (depth > 6) return null;
  let e = String(expr).trim();
  while (e.startsWith('(') && closeParen(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  if (!e) return null;
  const plus = splitTop(e, '+');
  if (plus.length > 1) {
    const parts = plus.map((p) => evalPath(p, defs, depth + 1));
    return parts.includes(null) ? null : parts.join('');
  }
  const slash = splitTop(e, '/');
  if (slash.length > 1 && slash.every(Boolean)) {
    const parts = slash.map((p) => evalPath(p, defs, depth + 1));
    return parts.includes(null) ? null : parts.join('/');
  }
  let m = e.match(/^[rRuUbB]?(['"])([^'"]*)\1$/);
  if (m) return m[2].replace(/\\\\/g, '\\');
  const interp = (body, re) => {
    let bad = false;
    const s = body.replace(re, (_, x) => {
      const v = evalPath(x, defs, depth + 1);
      if (v === null) bad = true;
      return v || '';
    });
    return bad ? null : s;
  };
  if ((m = e.match(/^`([^`]*)`$/))) return interp(m[1], /\$\{([^}]*)\}/g);
  if ((m = e.match(/^[fF][rR]?(['"])([^'"]*)\1$/))) return interp(m[2], /\{([^}]*)\}/g);
  if (HOME_EXPR.test(e)) return '~';
  if (CWD_EXPR.test(e)) return '.';
  for (const [re, join] of [[JOIN_CALL, true], [SAME_CALL, false]]) {
    const c = e.match(re);
    if (c && closeParen(e, c[0].length - 1) === e.length - 1) {
      const args = splitTop(e.slice(c[0].length, -1), ',').filter(Boolean);
      if (!join) return args.length ? evalPath(args[0], defs, depth + 1) : null;
      const parts = args.map((a) => evalPath(a, defs, depth + 1));
      return parts.includes(null) ? null : parts.join('/') || '.';
    }
  }
  if (/^[A-Za-z_$][\w$]*$/.test(e) && defs.has(e)) return evalPath(defs.get(e), defs, depth + 1);
  return null;
}

// 푼 쓰기 대상이 보호 경로(또는 그것을 담은 폴더)인지. 요청 폴더 안은 통과
function protectedTarget(p, cwd) {
  const norm = (x) => path.posix.normalize(x.replace(/\\/g, '/')).toLowerCase();
  const abs = norm(p.startsWith('~') ? p : path.resolve(cwd || process.cwd(), p));
  for (const x of [norm(p), abs]) {
    if (mentionsProtected(x) || mentionsProtected(`${x}/`)) return true;
    if (PROTECTED_DIR.test(x) && !REQUESTS_PATH.test(x)) return true;
  }
  return false;
}

// 인자 목록을 위치 인자와 이름 인자(name=value)로
function callArgs(inner) {
  const pos = [];
  const kw = {};
  for (const a of splitTop(inner, ',').filter(Boolean)) {
    const m = a.match(/^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/);
    if (m) kw[m[1]] = m[2];
    else pos.push(a);
  }
  return { pos, kw };
}

// 모듈 함수로 부르는 쓰기(fs.writeFileSync(p, …), os.remove(p), shutil.move(a, b), 구조 분해한 writeFileSync(p))
const ONE_TARGET = new Set(['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'unlinkSync', 'unlink', 'rmSync', 'rm', 'rmdirSync', 'rmdir', 'mkdirSync', 'mkdir', 'truncateSync', 'truncate', 'utimesSync', 'utimes', 'chmodSync', 'chmod', 'chownSync', 'chown', 'mkdtempSync', 'mkdtemp', 'remove', 'removedirs', 'makedirs', 'rmtree']);
const TWO_TARGETS = new Set(['renameSync', 'rename', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'symlinkSync', 'symlink', 'linkSync', 'link', 'replace', 'copy', 'copy2', 'copyfile', 'copytree', 'move']);
const MODULE_RECV = /^(?:fs|fsp|fsPromises|fs\.promises|promises|os|shutil|require\(['"](?:node:)?fs(?:\/promises)?['"]\)(?:\.promises)?)$/;
// 대상 객체에 부르는 쓰기(Path(p).write_text(…), p.unlink())
const RECV_TARGET = new Set(['write_text', 'write_bytes', 'touch', 'unlink', 'mkdir', 'rmdir', 'rename', 'symlink_to', 'hardlink_to', 'chmod']);

// 점(.) 앞의 받는 식 시작 위치(이름·점·괄호를 거슬러 올라간다)
function receiverStart(code, dot) {
  let j = dot - 1;
  while (j >= 0) {
    if (code[j] === ')' || code[j] === ']') {
      let depth = 0;
      for (; j >= 0; j--) {
        if (')]'.includes(code[j])) depth++;
        else if ('(['.includes(code[j]) && --depth === 0) break;
      }
      j--;
    } else if (/[\w$.]/.test(code[j])) j--;
    else break;
  }
  return j + 1;
}

// 인터프리터 코드가 보호 경로에 쓸 수 있는지. 쓰기 호출마다 대상을 풀어 보고, 풀 수 없거나 보호 경로면 막는다.
//   알아본 쓰기 호출을 지운 나머지에 쓰기 API가 남으면(별칭·모르는 방법) 막는다
function codeWritesProtected(code, cwd, strict = true) {
  if (OBFUSCATION.test(code)) return true;
  const defs = definitions(code);
  const blank = [];
  let found = 0;
  let blocked = false;
  const target = (expr) => {
    const p = expr === undefined ? null : evalPath(expr, defs);
    if (p === null || protectedTarget(p, cwd)) blocked = true;
  };
  for (const m of code.matchAll(/(\.\s*)?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    const open = m.index + m[0].length - 1;
    const close = closeParen(code, open);
    if (close < 0) continue;
    const { pos, kw } = callArgs(code.slice(open + 1, close));
    const start = m[1] ? receiverStart(code, m.index) : m.index;
    const recv = m[1] ? code.slice(start, m.index).replace(/\s+/g, '') : '';
    const moduleCall = !m[1] || MODULE_RECV.test(recv);
    if (name === 'open' || name === 'openSync') {
      const mode = pos[1] !== undefined ? pos[1] : kw.mode !== undefined ? kw.mode : kw.flags;
      const literalMode = mode === undefined ? '' : (String(mode).match(/^[rRbB]?(['"])([^'"]*)\1$/) || [])[2];
      if (literalMode === undefined || /[wax+]/.test(literalMode)) {
        found++;
        target(pos[0] !== undefined ? pos[0] : kw.file);
      }
      // 경로 객체의 open(Path(p).open('w')): 첫 인자가 쓰기 모드 글자이면 대상은 받는 식
      const pathMode = m[1] && !MODULE_RECV.test(recv) && (String(pos[0] !== undefined ? pos[0] : kw.mode || '').match(/^(['"])([rwaxbtU+]{1,4})\1$/) || [])[2];
      if (pathMode && /[wax+]/.test(pathMode)) {
        found++;
        target(code.slice(start, m.index));
      }
    } else if (moduleCall && (ONE_TARGET.has(name) || TWO_TARGETS.has(name))) {
      if (name === 'replace' && recv !== 'os') continue; // 문자열 replace
      found++;
      target(pos[0]);
      if (TWO_TARGETS.has(name)) target(pos[1]);
    } else if (!moduleCall && RECV_TARGET.has(name)) {
      found++;
      target(code.slice(start, m.index));
      if (name === 'rename' || name === 'symlink_to' || name === 'hardlink_to') target(pos[0]);
    } else if (!(m[1] && (name === 'write' || name === 'writelines'))) continue;
    // write·writelines: 연 파일(위 open에서 대상을 봤다)·표준 출력에 쓰는 내용이라 인자는 데이터
    blank.push([start, close + 1]);
  }
  if (blocked) return true;
  let rest = code;
  for (const [a, b] of blank.sort((x, y) => y[0] - x[0])) rest = rest.slice(0, a) + ' '.repeat(b - a) + rest.slice(b);
  if (WRITE_API.test(rest)) return true;
  return strict && !found && !READ_API.test(code); // 보호 이름만 나온 코드(strict 아님)는 쓰기가 없으면 통과
}

// 읽기만 하는 프로그램과, 그 출력을 받아도 쓰지 않는 거르기 프로그램. rg는 --pre로 다른 프로그램을 실행하므로 넣지 않는다
const READERS = new Set(['ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'wc', 'diff', 'stat', 'test', 'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi', 'test-path', 'select-string', 'sls', 'echo', 'write-output', 'write-host']);
const FILTERS = new Set([...READERS, 'convertfrom-json', 'select-object', 'select', 'measure-object', 'measure', 'cut', 'jq', 'findstr', 'out-string', 'format-list', 'fl', 'format-table', 'ft']);

// 보호 경로에 쓸 수 있는 명령인지 본다. 보호 경로가 나오는 명령에서
//  - 리다이렉트·쓰기 프로그램은 대상이 보호 경로이거나 알 수 없는 값(변수 등)일 때 막는다.
//    다른 파일에 쓰는 것은 통과(커밋 메시지 본문에 보호 파일 이름이 들어 있는 경우 등)
//  - 인터프리터는 코드가 읽기 API만 쓸 때만 통과시키고, 판단할 수 없으면 막는다
// .NET 읽기 호출 뒤에 이어 불러도 읽기로 보는 메서드(글자 다루기)
const SAFE_CHAIN = new Set(['tostring', 'trim', 'trimend', 'trimstart', 'replace', 'split', 'substring', 'tolower', 'toupper', 'contains', 'startswith', 'endswith', 'equals', 'isinrole']);
// ps: PowerShell 도구 명령(here-doc 본문을 떼지 않는다)
function writesApprovalFiles(command, cwd, depth = 0, ps = false) {
  if (depth > 6) return true; // 셸 문자열이 너무 깊게 묶이면 판단하지 않고 막는다
  if (!depth) decisionMemo.clear(); // 판단 사이에 파일 상태가 바뀔 수 있다(한 판단 안의 셸 문자열 재귀는 그대로 쓴다)
  command = dataHereStrings(neutralizeReadOnlyCli(foldConcat(resolveVars(command))));
  // 보호 폴더로 cd 등을 했으면 그 뒤의 모든 쓰기(상대 경로)를 보호 경로 쓰기로 본다
  const moved = movesIntoProtected(command, cwd);
  // 와일드카드 인자를 펼쳐 보호 경로에 닿으면 보호 경로가 언급된 것으로 본다(인터프리터에 인자로 넘기는 우회 포함)
  // 셸 특수 변수($? $# $$ $! $@ $* $0~9)는 경로가 아니다. ?·*를 와일드카드로, $를 알 수 없는 대상으로 보던 오탐(echo "exit=$?", pm 보고)
  // 값을 알 수 없는 토큰(${PIPESTATUS[0]}, 따옴표 안 CSS의 /* */·% 등)은 '보호 경로 언급'으로 치지 않는다(보고 5·4번).
  // 그런 토큰이 쓰기 프로그램·리다이렉트의 대상이면 아래에서 그대로 막고, 인터프리터 인자이면 그 조각만 민감하게 본다
  const unknownGlob = (a) => GLOB.test(a) && UNKNOWN_TARGET.test(a);
  // here-doc 본문(cat의 데이터, node·python의 코드)은 명령으로 나누지 않는다. 코드 본문은 그 인터프리터 조각에서 본다
  const { command: shell, bodies, heads, code, data, codeBodies } = ps ? noHeredocs(command) : splitHeredocs(command);
  // 데이터 본문(cat·tee)에만 나온 보호 이름은 '언급'으로 치지 않는다(KI-02: 시험 스크립트를 cat으로 쓰고 node로 실행).
  // 그 본문을 같은 명령에서 실행할 수도 있으니, 인터프리터가 있으면 본문을 코드로 보고 보호 경로·알 수 없는 대상에 쓰면 막는다
  // 명령 부분(본문 뺀 것)의 언급은 그대로 친다. 임시 사본 경로 토큰만 뺀다(powershell -c "Set-Content …" 같은 쓰기를 놓치지 않게)
  // 와일드카드는 본문까지(셸 특수 변수는 빼고) 본다
  const mentionedIn = (sh) => {
    const s = [sh, ...bodies.filter((b) => b !== null)].join('\n').replace(/\$[?#$!@*0-9]/g, '');
    return mentionsProtected(sh) || codeBodies.some(mentionsProtected) || mentionsProtected(tokens(sh).filter((a) => !tempCopy(a, cwd)).join(' ')) || (GLOB.test(s) && tokens(s).some((a) => GLOB.test(a) && !UNKNOWN_TARGET.test(a) && (riskyTarget(a, cwd) || globNamesProtected(a))));
  };
  // 명령 어디든 나온 언급: 관문·iex·링크 검사와 flow(아래)에 쓴다. 코드 실행 조각은 그 조각의 언급(own)으로 본다(D-35)
  const mentionedAll = mentionedIn(shell);
  // 본문을 실행할 수 없는 프로그램과 코드 인터프리터만 있을 때 통과. 그 밖(bash·. ·chmod 뒤 직접 실행·npx 등)은 보호 이름만 나와도 막는다
  // 맨 위 조각과 블록·하위 셸 안 조각(A1)은 한 번만 만든다. here-doc 본문은 맨 위 조각에만 짝짓는다
  const top = segments(shell);
  const segs = [...top, ...innerSegments(shell)];
  // 뗀 본문은 splitHeredocs가 찾은 머리가 든 맨 위 조각에 붙인다(머리 앞까지 나눈 조각 수로 찾는다. S3 관문 결함 1)
  // 그 조각의 프로그램이 머리에서 본 프로그램과 다르면(따옴표를 다르게 읽음) 해석할 수 없어 막는다(D-38)
  const bodyAt = new Map();
  for (const [j, { at, prog }] of heads.entries()) {
    if (bodies[j] === null) continue;
    const k = segments(shell.slice(0, at) + 'x').length - 1;
    if (progBase(leadingTokens(top[k] || '')[0]) !== prog) return true;
    bodyAt.set(k, bodyAt.has(k) ? `${bodyAt.get(k)}\n${bodies[j]}` : bodies[j]);
  }
  const progs = segs.map((s) => leadingTokens(s)[0]).filter(Boolean).map((p) => path.basename(p).toLowerCase().replace(/\.exe$/, ''));
  // 셸·PowerShell·cmd·iex가 실행할 명령 문자열(bash -c '…; rm …', -EncodedCommand)은 그 문자열을 한 명령으로 다시 판정한다
  if (segs.some((s) => {
    const inner = shellCode(stripRunners(leadingTokens(s)));
    return inner && writesApprovalFiles(inner, cwd, depth + 1);
  })) return true;
  const runsOther = progs.some((p) => !CODE_INTERPRETERS.has(p) && !HEREDOC_SAFE.has(p));
  const runsCode = progs.some((p) => CODE_INTERPRETERS.has(p));
  if (data.some((b) => SOFT_NAMES.test(b.replace(/\\/g, '/').toLowerCase()) && (runsOther || (runsCode && codeWritesProtected(b, cwd, false))))) return true;
  // .claude·설치본 폴더를 가리키는 링크(임시 폴더에 만들어도): 그 링크로 쓰면 임시 사본 예외를 빠져나간다
  // 따옴표·이스케이프로 쪼갠 이름(.cl''aude)도 보고, 와일드카드·변수·중괄호·식이 든 링크는 대상을 모르니 막는다
  const LINK = /\b(?:junction|symboliclink|hardlink|mklink)\b|^\s*ln\s|\bcp\s(?:.*\s)?(?:-[A-Za-z]*[sl][A-Za-z]*|--(?:symbolic-)?link)(?=\s|$)/i;
  // 링크 명령을 감싼 블록 앞부분($t = Measure-Command { mklink …)은 떼고 링크 명령만 본다(D-35)
  // 떼는 것은 블록 안이 링크 프로그램으로 시작할 때만(식 안의 링크 종류 글자로 앞의 -Path를 숨기지 못하게)
  const linkCmd = (s) => {
    const rest = s.slice(unclosedBefore(s, s.search(LINK)) + 1);
    return /^\s*(?:cmd(?:\.exe)?\s+\/[ck]\s+)?(?:mklink|ln|cp|new-item|ni)\s/i.test(rest) ? rest : s;
  };
  // 공백 든 따옴표 문자열로 시작하는 조각("junction secs=$(…)")은 PowerShell 출력 문자열이다. 그 문자열 안의 링크 종류 글자는 보지 않는다
  // 따옴표 안이 경로("…/junction.exe")이면 실행하는 프로그램이라 떼지 않는다. 문자열 안 $(…)·블록은 아래에서 안쪽 조각으로 따로 본다
  const notText = (s) => {
    const m = s.match(/^(["'])([^"']*\s[^"']*)\1/);
    return m && !/[\\/][^\\/\s]+$|\.(?:exe|cmd|bat|com|ps1)$/i.test(m[2]) ? s.slice(m[0].length) : s;
  };
  // 명령 치환으로 부른 링크 프로그램("$(command -v ln)" -s …, `which mklink` …)은 그 프로그램으로 본다
  const viaSub = (s) => {
    const m = s.match(/^(["']?)(?:\$\(([^()]*)\)|`([^`]*)`)\1(?=\s)/);
    const w = m && /\b(ln|mklink)\b/i.exec(m[2] ?? m[3]);
    return w ? w[1] + s.slice(m[0].length) : s;
  };
  // 경로·따옴표·실행기로 부른 링크 프로그램(/usr/bin/ln, "ln", env ln)도 링크로 본다
  const linkProg = (s) => ['ln', 'mklink'].includes(progName(stripRunners(leadingTokens(s))));
  // 값 모르는 프로그램에 링크 옵션(-s, /J)을 준 것($L -s …): 보호 이름이 나올 때만 링크로 친다
  const unknownLink = () => segs.some((s) => {
    const t = stripRunners(leadingTokens(s));
    return UNKNOWN_TARGET.test(t[0] || '') && t.slice(1).some((a) => /^-[bfnrvTLP]*s[bfnrvTLP]*$|^--symbolic$|^\/[jdh]$/i.test(a));
  });
  const linkSegs = [...segments(shell), ...innerSegments(shell)].map(viaSub).filter((s) => LINK.test(notText(s)) || linkProg(s)).map(linkCmd);
  if (linkSegs.some((s) => /\.claude\b|\.wy-tools/i.test(s.replace(/["'`\\^]/g, '')) || /[*?[$%{(`]/.test(s))) return true;
  // 같은 명령에서 링크를 만들고 보호 이름이 나오면(ln -s ~/proj /tmp/h && cp e /tmp/h/.claude/wy-ops.json) 임시 사본 예외를 믿을 수 없다
  if ((linkSegs.length || unknownLink() || /symlink|\blink(?:Sync)?\s*\(|hardlink_to|CreateSymbolicLink|CreateHardLink/i.test(code + shell)) && (SOFT_NAMES.test(command.replace(/\\/g, '/').toLowerCase()) || mentionedAll)) return true;
  // 보호 폴더·파일 이름만 나와도(경로가 변수·명령 치환으로 쪼개진 경우: D=$(echo …/wy-approvals/ns); rm $D/decisions/a)
  // 아래 리다이렉트·쓰기 프로그램 검사는 한다. 그 검사는 대상이 보호 경로이거나 알 수 없는 값일 때만 막는다
  // .claude 아래 경로에 모르는 값($ ` %)이 든 토큰도 이름이 나온 것으로 본다(cp x ~/.claude/$f, KI-08)
  // 쓰기 대상이 접을 수 없는 PowerShell 식이면 보호 이름 조각(NAME_PIECES)만 나와도 이름이 나온 것으로 본다(A3)
  const writes = segs.flatMap((seg) => {
    const t = leadingTokens(seg);
    const prog = progName(t);
    return WRITERS.has(prog) ? writeArgs(prog, t.slice(1), seg) || t.slice(1) : [];
  });
  const named = SOFT_NAMES.test(command.replace(/["'`^]/g, '').replace(/\\/g, '/').toLowerCase()) || tokens(shell).some((a) => /\.claude[\\/]\S*[$`%]/i.test(a)) || (NAME_PIECES.test(command) && writes.some((a) => /^[(@]/.test(a)));
  // 리다이렉트(> >> 2> *>). =>(화살표 함수)·->·>=는 리다이렉트가 아니다
  const redirects = [...shell.matchAll(/(?<![=\-<])(?:\d|\*)?>{1,2}(?!=)\s*("[^"]*"|'[^']*'|[^\s|;&<>)]+)/g)].map((m) => m[1].replace(/^["']|["']$/g, '')).filter((a) => !NULL_TARGET.test(a));
  // 와일드카드 관문: 펼쳐 볼 수 있는 와일드카드는 위 언급 검사(mentionedIn)에서 펼쳤다. 값을 모르는 와일드카드 토큰(~/.cl*/$f)만 관문을 연다(D-35).
  // 코드 본문은 남긴다(코드 안 와일드카드 경로 우회를 그대로 잡게)
  // 명령 치환·${…} 안의 [ ](PowerShell 형 변환 [int]·배열 첨자)는 경로 와일드카드가 아니다
  const pathGlob = (a) => {
    for (let b = ''; b !== a; ) [b, a] = [a, a.replace(/\$\([^()]*\)|\$\{[^{}]*\}/g, '')];
    return GLOB.test(a);
  };
  if (!moved && !mentionedAll && !named && !tokens(code.replace(/\$[?#$!@*0-9]/g, '')).some((a) => unknownGlob(a) && pathGlob(a))) {
    // 앞 명령에서 만든 링크로 보호 폴더에 쓰는 것은 보호 이름이 안 나와도 막는다(KI-08). 하드링크·깨진 링크는 이름이 나올 때만 본다
    return [...redirects, ...writes].some((a) => linkIntoProtected(a, cwd));
  }
  for (const target of redirects) if (moved || riskyTarget(target, cwd)) return true;
  // 코드를 실행하는 것(.NET 호출·인터프리터)은 조각 단위로 따진다(D-35). 보호 이름은 그 조각(파이프로 이어진 조각까지)에 나올 때만 친다 —
  // 다른 조각에서 읽기만 하면 통과. 이름이 명령 어디든 나오면(flow) 값을 모르는 인자(변수·식)는 보호 경로를 실어 나를 수 있다고 본다.
  // 알 수 없는 곳으로 이동만 했으면(moved, movedKnown 아님) 코드의 쓰기 대상만 풀어 본다(%TEMP% 사본에서 시험 실행)
  const flow = mentionedAll || named;
  // 값을 모르는 이동 대상에 보호 이름이 나오면(cd "$(dirname ~/.claude/…)", cd $(echo ~/.cl""aude)) 보호 폴더로 간 것으로 본다
  const movedKnown = moved && (movesIntoProtected(command, cwd, true) || segs.some((s) => {
    const t = leadingTokens(s);
    return CHDIR.has(progName(t)) && t.slice(1).some(unknownArg) && /\.claude\b|\.wy-tools|wy-approvals|wy-ops/i.test(s.replace(/["'`\\^]/g, ''));
  }));
  const units = [...segments(shell, false), ...innerSegments(shell, 0, false)];
  // 같은 글자를 조각·단위마다 여러 번 보므로(파일 시스템의 와일드카드 펼치기 포함) 결과를 담아 둔다
  const cached = (fn) => {
    const m = new Map();
    return (s) => {
      if (!m.has(s)) m.set(s, fn(s));
      return m.get(s);
    };
  };
  const ownIn = cached((s) => mentionsProtected(s) || tokens(s.replace(/\$[?#$!@*0-9]/g, '')).some((a) => GLOB.test(a) && !UNKNOWN_TARGET.test(a) && (riskyTarget(a, cwd) || globNamesProtected(a))));
  // 이름은 따옴표·이스케이프로 쪼갠 것(.wy-to""ols, 하위 셸 -c 문자열 안)도 본다
  const namedIn = cached((s) => SOFT_NAMES.test(s.replace(/["'`^]/g, '').replace(/\\/g, '/').toLowerCase()) || tokens(s).some((a) => /\.claude[\\/]\S*[$`%]/i.test(a)));
  // 단위를 파이프로 나눈 조각(단위마다 한 번)
  const unitParts = units.map((u) => segments(u));
  // 보호 이름이 읽기 단위(읽기 프로그램 → 거르기 프로그램 파이프, 리다이렉트·치환·블록 없음) 밖에 나오는지. 읽기 단위(cat·ls)에만 나오면 스크립트 실행과 상관없다.
  // 그 밖(대입·리다이렉트·쓰기 프로그램·Set-Variable 등)은 이름을 파일·변수에 담아 뒤 조각의 스크립트로 넘길 수 있다
  // 파이프에서는 이름이 처음 나온 조각부터 뒤(출력을 받는 쪽)만 본다
  const readOnly = (ps) => {
    const from = ps.findIndex((x) => ownIn(x) || namedIn(x));
    return from >= 0 && ps.slice(from).every((x, j) => (j ? FILTERS : READERS).has(progName(leadingTokens(x))) && !/[<>(){}`&]|\$\(/.test(x.replace(/\d?>&\d|\d?>\s*(?:\/dev\/null|nul|\$null)(?=\s|$)/gi, '')));
  };
  const carries = flow && units.some((u, i) => (ownIn(u) || namedIn(u)) && !readOnly(unitParts[i]));
  for (const [k, seg] of segs.entries()) {
    const body = k < top.length ? bodyAt.get(k) : null;
    const t = leadingTokens(seg);
    if (!t.length) continue;
    // 파이프에서 이 조각과 그 앞(입력을 넘기는 쪽)만 본다. 뒤에서 읽는 조각의 이름은 이 조각으로 흘러오지 않는다
    // 소속은 조각 단위로 맞춘다(다른 단위의 문자열 안에 같은 글자가 있어도 섞지 않게)
    const mine = unitParts.filter((ps) => ps.includes(seg)).map((ps) => ps.slice(0, ps.indexOf(seg) + 1).join(' | '));
    const own = () => ownIn(body ? `${seg}\n${body}` : seg) || mine.some(ownIn);
    const ownNamed = () => namedIn(body ? `${seg}\n${body}` : seg) || mine.some(namedIn);
    if (/^(?:\[[\w.]+\]|\$[\w:]+)::/.test(t[0])) {
      // [IO.File]::ReadAllText 같은 읽기만 통과. 형을 변수에 담아 부르는 것($f=[IO.File]; $f::WriteAllText)도 같다
      // 이름이 흐를 수 있으면(flow·moved) 값 모르는 인자나 쓰기 호출(대상이 식일 수 있다: WriteAllText((Get-Content l), …))을 본다
      const sensitive = movedKnown || own() || ownNamed() || ((flow || moved) && (UNKNOWN_TARGET.test(seg.replace(PS_CONST, '')) || WRITE_API.test(seg)));
      // 앞에 형 변환([void]·[X][Y]::…)·$x = 가 붙은 호출(전에는 보지 않던 형태)은 읽기 메서드(Get…·Parse…·Combine 등)도 통과시킨다.
      // 그 밖(맨 호출, ( ! & 뒤)은 전처럼 ReadAll·Exists만. 리플렉션(GetType(…).GetMethod(…).Invoke)은 읽기 이름으로 쓰기를 부를 수 있어 넓히지 않는다
      const castOrSet = /^\s*\(?\s*(?:\[[\w.]+\]\s*(?=\[)|\$[\w:]+\s*=)/.test(seg) && !/\b(?:Invoke\w*|GetMethods?|CreateInstance|Activator)\b/i.test(seg);
      const reads = !castOrSet ? /^(?:\[[\w.]+\]|\$[\w:]+)::(?:ReadAll|Exists)/i : /^(?:\[[\w.]+\]|\$[\w:]+)::(?:ReadAll|Exists|Get|Combine|Enumerate|Parse|Join|Is|Has)/i;
      // 읽기 호출 뒤에 이어 부른 메서드(…).GetType().GetMethod(…)는 읽기로 보지 않는다(U8). 글자 다루는 메서드만 된다
      const chained = [...seg.matchAll(/\)\s*\.\s*([A-Za-z_]\w*)\s*\(/g)].every((m) => SAFE_CHAIN.has(m[1].toLowerCase()));
      if (!sensitive || (reads.test(t[0]) && !WRITE_API.test(seg) && chained)) continue;
      return true;
    }
    const prog = progName(t);
    const rest = t.slice(1);
    // Start-Process는 풀어서 본다(결함 2): 리다이렉트 대상은 쓰기, 셸·인터프리터에 글자 인자를 주면 그 명령으로 다시 판정,
    // 그 밖은 인자에 보호 경로·이름·와일드카드가 없으면 통과(경로에 claude 낱말만 든 임시 폴더 인자 오탐). 못 풀면 전처럼 쓰기 프로그램으로 본다
    // -WorkingDirectory가 있으면 상대 경로 인자가 어디로 갈지 따로 봐야 해서 풀지 않는다(전처럼). 프로그램 경로가 보호 경로여도 그렇다
    const sp = (prog === 'start-process' || prog === 'saps') && startProcess(seg);
    if (sp && sp.args && !sp.wd && !sp.files.some((f) => mentionsProtected(f) || namedIn(f))) {
      if (sp.redirects.some((a) => moved || riskyTarget(a, cwd))) return true;
      const runs = sp.files.map((f) => progName([f]));
      if (runs.some((p) => INTERPRETERS.has(p) || RUNNERS.has(p))) {
        if (sp.files.length === 1) {
          if (writesApprovalFiles([`"${sp.files[0]}"`, ...sp.args.map((a) => `'${a.replace(/'/g, "''")}'`)].join(' '), cwd, depth + 1)) return true;
          continue;
        }
      } else {
        const a = sp.args.join(' ');
        // 상대 경로 인자는 cwd 기준으로 풀어 본다(쓰기 프로그램으로 보던 e01ca5d 전과 같게, S3 관문 #4)
        const resolved = (x) => !x.startsWith('~') && mentionsProtected(path.resolve(cwd || process.cwd(), x));
        if (moved || mentionsProtected(a) || namedIn(a) || sp.args.some((x) => GLOB.test(x) || resolved(x))) return true;
        continue;
      }
    }
    // .NET 객체로 쓰기: (New-Object IO.StreamWriter 경로), (Get-Item 경로).Delete()·.MoveTo(…)
    // 이름이 명령 어디든 나오면(flow) 변수에 담은 객체의 쓰기 메서드($f.Delete())도 막는다(U8)
    if ((own() || ownNamed() || (flow && /^\$/.test(t[0]))) && (prog === 'new-object' || PS_WRITE_METHOD.test(seg.trim().replace(/^(?:\$[\w:]+\s*=\s*|\[[\w.]+\]\s*)+/, '')))) return true;
    // 쓰기 프로그램은 인자가 보호 경로로 갈 수 있을 때만 막는다(직접 언급·알 수 없는 값·와일드카드 펼친 결과)
    // PowerShell 내용 쓰기는 내용(데이터)을 빼고 대상 인자만 본다
    // 남은 here-string(내용 자리가 아니라 dataHereStrings가 그대로 둔 것)은 토큰으로 나눌 수 없으니 조각 전체로 본다
    // 복사 프로그램은 대상(마지막 인자·-Destination)만 본다. 임시 폴더 사본 안의 설정 경로는 보호 대상이 아니다(KI-02)
    const targets = writeArgs(prog, rest, seg);
    // riskyTarget은 임시 사본을 빼고 본다. 조각 전체 언급은 임시 사본 토큰이 있을 때만 그 토큰을 뺀 나머지로 본다
    const notTemp = (list) => list.filter((a) => !tempCopy(a, cwd));
    // 쓰기 프로그램·find에서만 쓰므로 그때 계산한다(대상마다 파일 시스템을 본다)
    const risky = () => moved || (targets ? targets.some((a) => riskyTarget(a, cwd)) || mentionsProtected(notTemp(targets).join(' ')) : rest.some((a) => riskyTarget(a, cwd)) || mentionsProtected(!COPIERS.has(prog) && rest.some((a) => tempCopy(a, cwd)) ? notTemp(rest).join(' ') : seg));
    if (WRITERS.has(prog) && risky()) return true;
    // 문자열을 코드로 실행(파이프로 받는 iex): 실행할 코드가 앞 조각에 있으므로 명령 어디든 보호 이름이 나오면 막는다
    if ((prog === 'iex' || prog === 'invoke-expression') && (mentionedAll || named)) return true;
    if (prog === 'sed' && rest.some((a) => a.startsWith('-i') || a.startsWith('--in-place')) && (moved || mentionsProtected(seg) || sedFiles(rest).some((a) => riskyTarget(a, cwd)))) return true;
    if (prog === 'find' && rest.some((a) => ['-delete', '-exec', '-execdir', '-ok'].includes(a)) && risky()) return true;
    // rg --pre는 찾는 파일마다 다른 프로그램을 실행한다(보호 파일이 그 프로그램에 넘어간다)
    if (prog === 'rg' && rest.some((a) => /^--pre(?:=|$)/.test(a)) && (own() || flow)) return true;
    if (!INTERPRETERS.has(prog)) continue;
    // 판단할 수 없는 코드(읽기 API도 없음)를 막는 엄한 판정: 이 조각에 보호 경로가 나오거나, 보호 폴더로 이동했거나, 값 모르는 인자로 이름이 흘러올 수 있을 때
    // 알 수 없는 곳으로 이동만 했으면 쓰기 API를 부르는 코드만 엄하게 본다(상대 경로 대상을 풀 수 없다). 시험 파일 실행(node $f)은 통과
    // 이름을 파일·변수에 담았으면(carries) 이 코드(스크립트 파일·load·-r로 부른 파일 포함)가 그것을 받을 수 있다
    const strict = own() || rest.some(unknownGlob) || movedKnown || carries || (flow && rest.some(unknownArg)) || (moved && WRITE_API.test([rest.join(' '), body || ''].join('\n')));
    if (CODE_INTERPRETERS.has(prog) && (strict || moved || flow || ownNamed())) {
      // node·python 등은 쓰기 호출의 대상을 풀어 본다(다른 파일에 쓰면서 내용에 보호 경로 이름이 든 코드는 통과, 0.8.0).
      // 보호 폴더 이름만 나와도(path.join(…, 'wy-approvals', …, 'decisions')처럼 경로가 조각난 경우) 대상을 본다
      // 보호 폴더로 옮긴 뒤의 쓰기 호출은 상대 경로 대상을 옮기기 전 폴더로 풀 수 없으니 막는다
      if (movedKnown && WRITE_API.test([rest.join(' '), body || ''].join('\n'))) return true;
      if (codeWritesProtected([rest.join(' '), body || ''].join('\n'), cwd, strict)) return true;
    } else if (!CODE_INTERPRETERS.has(prog) && (strict || moved || flow || ownNamed())) {
      // 셸·PowerShell·cmd는 이름이 명령 어디든 나오면 본다(-c 문자열 안 와일드카드·\로 쪼갠 이름, 표준 입력·스크립트 파일 실행은 대상을 풀 수 없다)
      const code = rest.join(' ');
      // cmd /c dir(폴더 목록)는 읽기다. 뒤에 이어 붙인 명령·리다이렉트(& | ^& < >)가 있으면 아니다
      // dir.bat·dir.cmd(같은 이름의 스크립트)와 %변수%는 읽기가 아니다
      if (WRITE_API.test(code) || OBFUSCATION.test(code) || !(READ_API.test(code) || (prog === 'cmd' && /^\/[ck]\s+["']?dir(?=\s|["']?$)[^&|<>^%]*$/i.test(code)))) return true;
    }
  }
  return false;
}

// 같은 종류·같은 명령으로 승인된, 아직 쓰지 않은 결정을 찾는다(taken에 든 것은 건너뛴다)
function findApproval(kind, segment, taken, root, ttlMs) {
  const p = store.paths(root);
  const want = store.normalize(segment);
  let files = [];
  try {
    files = fs.readdirSync(p.decisions).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const f of files) {
    const id = f.slice(0, -5);
    if (!store.ID_RE.test(id) || taken.has(id) || fs.existsSync(path.join(p.used, f))) continue;
    let d;
    try {
      d = store.readJson(path.join(p.decisions, f));
    } catch {
      continue;
    }
    const fresh = Date.now() - Date.parse(d.decidedAt) < ttlMs;
    if (d.decision === 'approved' && d.kind === kind && store.normalize(d.command) === want && fresh) return id;
  }
  return null;
}

function markUsed(ids, input, root) {
  const p = store.paths(root);
  fs.mkdirSync(p.used, { recursive: true });
  for (const id of ids) {
    fs.writeFileSync(path.join(p.used, `${id}.json`), JSON.stringify({ id, usedAt: new Date().toISOString(), session_id: input.session_id || null }) + '\n');
  }
}

// S4 D-32 예외: 역할 세션이 자기 worktree에서 기준 가지를 자기 가지에 합치는 `git merge <base>` 한 명령.
// 명령 전체가 이 세 낱말뿐이어야 한다(옵션·-C·환경 변수·cd·다른 조각이 붙으면 아님). cwd는 .claude/worktrees/<agent_type> 안,
// 그 폴더의 .git이 본 저장소 .git/worktrees/ 아래를 가리키는 표지 파일이고 HEAD가 wt/<역할> 가지여야 한다.
// base는 본 저장소의 wy-ops.json(+local) worktree.base(없으면 예외 없음). worktree 안 사본은 역할 세션이 고칠 수 있어 보지 않는다
function ownWorktreeMerge(input, command) {
  const t = tokens(command.trim());
  if (t.length !== 3 || !/^git(?:\.exe)?$/i.test(t[0]) || t[1] !== 'merge' || segments(command).length !== 1 || innerSegments(command).length) return false;
  return t[2] === ownWorktreeBase(input);
}

// 이 세션이 자기 worktree(cwd·.git 표지·HEAD wt/<역할>)에 있으면 본 저장소의 worktree.base, 아니면 null
function ownWorktreeBase(input) {
  const role = input.agent_type;
  if (!role || !input.cwd) return null;
  const cwd = path.resolve(input.cwd);
  const m = [...cwd.matchAll(/[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)(?=[\\/]|$)/g)].pop();
  if (!m || m[1] !== role) return null;
  const repo = cwd.slice(0, m.index);
  const wt = cwd.slice(0, m.index + m[0].length);
  const ops = loadOpsConfig(repo);
  const base = ops && ops.worktree && ops.worktree.base;
  if (typeof base !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith('-') || ops.root !== repo) return null;
  try {
    const dotGit = fs.readFileSync(path.join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    const admin = dotGit && path.resolve(wt, dotGit[1]);
    const rel = admin && path.relative(path.join(repo, '.git', 'worktrees'), admin);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const head = fs.readFileSync(path.join(admin, 'HEAD'), 'utf8').trim();
    return head === `ref: refs/heads/wt/${role}` ? base : null;
  } catch {
    return null;
  }
}

// rootOverride는 테스트용. 보통은 훅 입력의 cwd로 프로젝트 승인 폴더를 정한다
function evaluate(input, rootOverride) {
  const command = String((input.tool_input && input.tool_input.command) || '');
  if (!command) return null;
  const ps = input.tool_name === 'PowerShell';
  if (writesApprovalFiles(command, input.cwd || process.cwd(), 0, ps)) {
    return {
      decision: 'deny',
      reason: '승인 파일(~/.claude/wy-approvals 아래 decisions·decisions.log·used·sessions·message-blocks.log·.trust), 설치본(~/.wy-tools), 프로젝트 설정(.claude/wy-ops.json·wy-ops.local.json·settings.local.json)에는 셸 명령으로 쓸 수 없습니다. 읽기(cat·ls·tail·test)는 됩니다. 설정 변경은 내용을 pm 세션에 보내 사용자가 고치게 하세요.',
    };
  }
  const root = rootOverride || store.rootFor(input.cwd || process.cwd());
  // git 명령에 붙은 here-doc 본문(git commit -F - <<'EOF' … 커밋 메시지)의 'git 낱말' 줄은 별칭 판정에서 뺀다
  // cat·tee·인터프리터 here-doc 본문도 데이터·코드라 셸 명령으로 보지 않는다(결함 3). 인터프리터 본문은 X3로 따로 본다
  // 같은 명령에서 데이터 본문을 쓴 파일을 셸 등 모르는 프로그램이 실행할 수 있으면(cat > x.sh <<EOF … ; bash x.sh) 본문도 명령으로 본다(전처럼).
  // 인터프리터만 돌면(cat > ed.py … ; python ed.py) 데이터 본문도 코드로 보고 X3로 본다
  const heredocs = ps ? noHeredocs(command) : splitHeredocs(command);
  const segTokens = allSegments(heredocs.command).map((s) => stripRunners(leadingTokens(s)));
  const runs = segTokens.map((t) => progName(t)).filter(Boolean);
  // git(훅 파일)·sed(e 명령)·다른 프로세스를 부르는 인터프리터 코드(python -c "os.system('sh x.sh')")는 본문을 실행할 수 있다
  const interpExec = segTokens.some((t) => CODE_INTERPRETERS.has(progName(t)) && execCode(progName(t), t.slice(1).join(' ')));
  //   git은 커밋 메시지 파일(cat > .git/MSG <<'EOF' … git commit -F)이 흔해 훅 폴더에 쓸 때만 본다
  const gitHook = runs.includes('git') && /hooks/i.test(heredocs.command);
  const execsData = heredocs.data.length && (interpExec || gitHook || runs.some((p) => !HEREDOC_SAFE.has(p) && !FILTERS.has(p) && !CODE_INTERPRETERS.has(p) && !['git', 'sort', 'uniq', 'tr', 'printf'].includes(p)));
  // 따옴표 없는 구분자 본문의 $(…)·백틱은 셸이 실행하므로 splitHeredocs가 그 본문을 명령으로 남긴다
  // git commit·merge의 메시지 본문도 뗀다(본문 줄의 'git 낱말'을 별칭으로 보지 않게). PowerShell에는 here-doc이 없다
  const shell = ps ? command : splitHeredocs(command, true, !execsData).command;
  const codes = [...heredocs.codeBodies.map((b, j) => [heredocs.codeProgs[j], b]), ...(runs.some((p) => CODE_INTERPRETERS.has(p)) ? heredocs.data.map((b) => ['', b]) : [])];
  const judged = allSegments(shell).map((s) => ({ segment: s, kind: classify(s, 0, shell) }));
  const unknown = (judged.find((g) => g.kind === 'unknown') || {}).segment || (codes.find(([p, b]) => execCode(p, b) && gitWord(b)) || [])[1];
  if (unknown) {
    return { decision: 'deny', reason: `git 별칭·외부 명령, 한 셸 문자열 안의 잠금 명령 여럿, 또는 해석할 수 없는 형태(쪼갠 이름·변수 프로그램·실행 설정·다른 프로그램이 대신 실행하는 git)는 판단할 수 없어 막습니다: "${store.normalize(unknown).slice(0, 200)}". 정식 하위 명령(git commit·git status …)을 하나씩 따로, 셸에서 바로 쓰세요.` };
  }
  const guarded = judged.filter((g) => g.kind);
  if (!guarded.length) return null;
  if (ownWorktreeMerge(input, command)) return null; // 평소 권한 흐름대로
  const ops = loadOpsConfig(input.cwd || process.cwd());
  const COMMIT_SESSION = ops && typeof ops.commitRole === 'string' && ops.commitRole;
  if (!COMMIT_SESSION) {
    return { decision: 'deny', reason: `'${store.KINDS[guarded[0].kind]}' 명령은 커밋 역할만 실행합니다. 이 프로젝트의 .claude/wy-ops.json에 commitRole이 없습니다(install.ps1 init으로 만듭니다).` };
  }
  const ttlMinutes = Number(ops && ops.approvals && ops.approvals.ttlMinutes);
  const ttlMs = (ttlMinutes > 0 ? ttlMinutes : DEFAULT_TTL_MINUTES) * 60 * 1000;
  if (input.agent_type !== COMMIT_SESSION) {
    const who = input.agent_type || 'agent_type 없음';
    // D-32 예외에 다른 조각·옵션이 붙어 거부될 때(S5 실사용): 판정은 그대로, 이유에 단독 실행 안내만 덧붙인다
    const base = guarded.some((g) => g.kind === 'merge') && ownWorktreeBase(input);
    const hint = base && guarded.some((g) => g.kind === 'merge' && tokens(g.segment).includes(base)) ? ` 기준 가지를 받는 것이면 \`git merge ${base}\`만 따로(파이프·cd·다른 명령·옵션 없이) 실행하면 승인 없이 됩니다.` : '';
    return { decision: 'deny', reason: `'${store.KINDS[guarded[0].kind]}' 명령은 ${COMMIT_SESSION}(--agent ${COMMIT_SESSION}로 실행한 세션)만 실행합니다(이 세션: ${who}). 커밋 요청은 ${COMMIT_SESSION}에 보내세요.${hint}` };
  }
  // 조각마다 승인을 먼저 다 찾고, 모두 있을 때만 한꺼번에 사용 표시를 남긴다(일부만 쓰고 막히면 승인이 헛되이 사라진다)
  const taken = new Set();
  for (const g of guarded) {
    const id = findApproval(g.kind, g.segment, taken, root, ttlMs);
    if (!id) {
      return {
        decision: 'deny',
        reason: `승인이 없습니다: ${store.KINDS[g.kind]} "${store.normalize(g.segment)}". ${store.paths(root).requests}에 요청 파일을 쓰고(command에 이 명령 그대로) 승인 센터의 결정을 기다린 뒤 다시 실행하세요.`,
      };
    }
    taken.add(id);
  }
  markUsed(taken, input, root);
  return { decision: 'allow', reason: `승인 센터 결정 ${[...taken].join(', ')}` };
}

// 이 훅이 실제로 받은 agent_type을 세션 등록 기록(sessions/<sessionId>.json)에 덧쓴다(agentTypeSeen·seenAt).
// SessionStart 훅은 fork로 이어 띄운 세션의 agent_type을 받지 못해 null을 남긴다(커밋 역할 누락 오탐).
// 도구를 한 번 쓴 뒤에는 여기 남은 값이 역할 판정의 근거가 된다. 값이 바뀔 때만 쓴다
function noteAgentType(input, root) {
  const id = String(input.session_id || '');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) return null;
  const dir = path.join(root, 'sessions');
  const file = path.join(dir, `${id}.json`);
  let rec = {};
  try {
    rec = store.readJson(file) || {};
  } catch {
    // 기록이 없으면(훅 설치 전에 뜬 세션) 새로 만든다
  }
  const seen = input.agent_type || null;
  if (rec.seenAt && rec.agentTypeSeen === seen) return rec;
  const out = { sessionId: id, agentType: rec.agentType === undefined ? null : rec.agentType, ...rec, agentTypeSeen: seen, seenAt: new Date().toISOString() };
  fs.mkdirSync(dir, { recursive: true });
  store.writeJsonAtomic(file, out);
  return out;
}

function respond(result) {
  if (!result) process.exit(0); // 잠금 대상이 아니면 평소 권한 흐름대로
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision, permissionDecisionReason: result.reason } };
  process.stdout.write(JSON.stringify(out));
  if (result.decision === 'deny') {
    process.stderr.write(result.reason + '\n');
    process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      try {
        noteAgentType(input, store.rootFor(input.cwd || process.cwd()));
      } catch {
        // 기록은 판정 근거를 보태는 일이라 실패해도 가드 판단에 영향을 주지 않는다
      }
      respond(evaluate(input));
    } catch (err) {
      // 판단을 못 하면 막는다. 잠금 대상이 아니었더라도 원인을 알 수 있게 사유를 남긴다
      process.stderr.write(`WY 승인 가드 오류로 막았습니다: ${err.message}\n`);
      process.exit(2);
    }
  });
}

module.exports = { segments, classify, evaluate, writesApprovalFiles, noteAgentType };
