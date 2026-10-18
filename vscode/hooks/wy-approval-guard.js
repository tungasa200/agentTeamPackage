#!/usr/bin/env node
// wy-ops 승인 가드(PreToolUse 훅, Bash·PowerShell). 초안 — 적용은 사용자 설정에서 한다.
// - 잠금 대상 git 명령: commit·push·강제 푸시·브랜치 생성/삭제·merge(gh pr merge)·reset·rebase·태그 삭제. 모두 승인 센터의 승인 결정이 있어야 한다.
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
// 버리는 리다이렉트 대상
const NULL_TARGET = /^(?:\/dev\/null|nul|\$null|&\d)$/i;
const LEADING_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'until', 'while', 'if', '!', '{', '(', 'time', 'exec', 'sudo', 'env', '&']);

// 명령을 &&, ||, ;, |, 줄바꿈으로 나눈다(따옴표 안은 나누지 않는다)
function segments(command) {
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
    } else if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      if (ch === '&' || (ch === '|' && command[i + 1] === '|')) i++;
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// 블록·하위 셸·명령 치환 안의 명령 조각(KI-08 A1): 작은따옴표 밖의 ( ) { } 와 백틱 안쪽을 다시 조각으로 나눈다(안쪽의 안쪽도).
// 큰따옴표 안에서는 $( )와 백틱만 실행된다. 맨 위 조각(segments)에 더해 같은 판정을 받는다
function innerSegments(s, depth = 0) {
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
    out.push(...segments(inner), ...innerSegments(inner, depth + 1));
    i = end;
  }
  return out;
}
const allSegments = (s) => [...segments(s), ...innerSegments(s)];

function tokens(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

// 한 조각이 잠금 대상이면 종류를, 아니면 null
function classify(segment) {
  let t = tokens(segment);
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t = t.slice(1); // 앞의 VAR=값
  if (!t.length) return null;
  const prog = path.basename(t[0]).toLowerCase().replace(/\.exe$/, '');
  if (prog === 'gh') return t[1] === 'pr' && t[2] === 'merge' ? 'merge' : null;
  if (prog !== 'git') return null;
  let i = 1;
  while (i < t.length && t[i].startsWith('-')) {
    i += GIT_OPTS_WITH_VALUE.has(t[i]) ? 2 : 1;
  }
  const sub = t[i];
  const rest = t.slice(i + 1);
  const has = (...flags) => rest.some((a) => flags.includes(a) || flags.some((f) => f.endsWith('=') && a.startsWith(f)));
  const positional = rest.filter((a) => !a.startsWith('-'));
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
  while (t.length && (LEADING_KEYWORDS.has(t[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || /^\$\w+\s*=/.test(t[0]))) t = t.slice(1);
  return t;
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

// 대상을 알 수 없는 인자: 변수·명령 치환, PowerShell 식((…), @(…)·@splat)
const unknownArg = (a) => UNKNOWN_TARGET.test(a) || /^[(@]/.test(a);

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

// 명령 안에 보호 폴더(또는 알 수 없는 곳)로 들어가는 이동이 있는지
function movesIntoProtected(command, cwd) {
  const segs = allSegments(command);
  return segs.some((seg, i) => {
    const t = leadingTokens(seg);
    const prog = t.length ? path.basename(t[0]).toLowerCase() : '';
    if (!CHDIR.has(prog)) return false;
    // 맨 끝의 popd(pushd … && popd 되돌리기)는 뒤에 쓰기가 없으므로 보지 않는다
    if (HIDDEN_CHDIR.has(prog) || t.slice(1).includes('-')) return i < segs.length - 1;
    const args = t.slice(1).filter((a) => !/^-/.test(a));
    const up = PARENT_REF.test(command);
    // 요청 폴더(requests/) 안으로의 이동은 통과(..로 거슬러 오르지 않을 때). 카드를 임시 이름으로 쓰고 rename하는 절차(0.8.0 오탐 수정)
    const into = (p) => (PROTECTED_DIR.test(p) && (up || !REQUESTS_PATH.test(p))) || (up && CLAUDE_SUBDIR.test(p));
    return args.some((a) => {
      if (into(a.replace(/\\/g, '/').toLowerCase()) || into(normDir(a)) || unknownArg(a)) return true;
      // 링크를 지나 보호 폴더로 들어가는 이동(앞 명령에서 만든 링크)
      if (!GLOB.test(a)) {
        const x = locate(a, cwd);
        if (!x.real || (x.real !== x.abs && into(x.real))) return true;
      }
      if (!GLOB.test(a) && !a.startsWith('~') && into(normDir(path.resolve(cwd || process.cwd(), a)))) return true; // cwd 기준(.claude/jobs에서 cd ..)
      if (!GLOB.test(a)) return false;
      const hits = expandGlob(a, cwd);
      return !hits.length || hits.some(into); // 펼칠 수 없으면 알 수 없는 곳으로 본다
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

// here-doc 본문을 떼어 낸다. 셸(bash 등)이나 모르는 프로그램의 본문은 명령이므로 그대로 둔다.
//   돌려줌 { command: 본문을 뺀 명령, bodies: here-doc 머리 순서대로 본문(그대로 둔 것은 null),
//           code: 데이터 본문(cat·tee)만 뺀 명령 — 실행되지 않는 데이터의 ?·[·*를 와일드카드로 보지 않게(2026-10-10 pm 오탐) }
function splitHeredocs(command) {
  const lines = command.split('\n');
  const out = [];
  const code = [];
  const bodies = [];
  const data = [];
  const codeBodies = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    code.push(line);
    const m = line.match(/<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/);
    if (!m) continue;
    const before = segments(line.slice(0, m.index)).pop() || '';
    const t = leadingTokens(before);
    const prog = t.length ? path.basename(t[0]).toLowerCase().replace(/\.exe$/, '') : '';
    const end = lines.findIndex((l, j) => j > i && (m[1] ? l.replace(/^\t+/, '') : l) === m[3]);
    if (end < 0 || !(HEREDOC_DATA.has(prog) || CODE_INTERPRETERS.has(prog))) {
      bodies.push(null);
      continue;
    }
    bodies.push(lines.slice(i + 1, end).join('\n'));
    if (CODE_INTERPRETERS.has(prog)) {
      code.push(...lines.slice(i + 1, end));
      codeBodies.push(bodies[bodies.length - 1]);
    } else data.push(bodies[bodies.length - 1]);
    i = end;
  }
  return { command: out.join('\n'), bodies, code: code.join('\n'), data, codeBodies };
}

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
const READERS = new Set(['ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'wc', 'diff', 'stat', 'test', 'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi', 'test-path', 'select-string', 'sls']);
const FILTERS = new Set([...READERS, 'convertfrom-json', 'select-object', 'select', 'measure-object', 'measure', 'cut', 'jq', 'findstr', 'out-string', 'format-list', 'fl', 'format-table', 'ft']);
// 읽기 조각(KI-08)의 [시작, 끝] 위치: 인자의 보호 경로를 '언급'으로 치지 않는다(설치본을 읽고 같은 명령에서 node로 시험 실행).
// 리다이렉트·명령 치환·괄호·중괄호·&(뒤에 붙은 명령)가 있거나, 출력이 파이프로 거르기 아닌 프로그램(인터프리터·xargs·쓰기 프로그램)에 가면 읽기 조각이 아니다
function quietReads(shell) {
  const segs = segments(shell);
  const prog = (s) => progName(leadingTokens(s));
  const plain = (s) => !/[<>(){}`&]|\$\(/.test(s);
  const at = [];
  let pos = 0;
  for (const s of segs) {
    at.push(shell.indexOf(s, pos));
    pos = at[at.length - 1] + s.length;
  }
  const piped = segs.map((s, i) => /^[ \t]*\|(?!\|)/.test(shell.slice(at[i] + s.length)));
  return segs
    .map((s, i) => [at[i], at[i] + s.length, i])
    .filter(([, , i]) => {
      if (!READERS.has(prog(segs[i])) || !plain(segs[i])) return false;
      for (let j = i; piped[j]; j++) if (!segs[j + 1] || !FILTERS.has(prog(segs[j + 1])) || !plain(segs[j + 1])) return false;
      return true;
    });
}

// 보호 경로에 쓸 수 있는 명령인지 본다. 보호 경로가 나오는 명령에서
//  - 리다이렉트·쓰기 프로그램은 대상이 보호 경로이거나 알 수 없는 값(변수 등)일 때 막는다.
//    다른 파일에 쓰는 것은 통과(커밋 메시지 본문에 보호 파일 이름이 들어 있는 경우 등)
//  - 인터프리터는 코드가 읽기 API만 쓸 때만 통과시키고, 판단할 수 없으면 막는다
function writesApprovalFiles(command, cwd) {
  decisionMemo.clear(); // 판단 사이에 파일 상태가 바뀔 수 있다
  command = dataHereStrings(neutralizeReadOnlyCli(foldConcat(resolveVars(command))));
  // 보호 폴더로 cd 등을 했으면 그 뒤의 모든 쓰기(상대 경로)를 보호 경로 쓰기로 본다
  const moved = movesIntoProtected(command, cwd);
  // 와일드카드 인자를 펼쳐 보호 경로에 닿으면 보호 경로가 언급된 것으로 본다(인터프리터에 인자로 넘기는 우회 포함)
  // 셸 특수 변수($? $# $$ $! $@ $* $0~9)는 경로가 아니다. ?·*를 와일드카드로, $를 알 수 없는 대상으로 보던 오탐(echo "exit=$?", pm 보고)
  // 값을 알 수 없는 토큰(${PIPESTATUS[0]}, 따옴표 안 CSS의 /* */·% 등)은 '보호 경로 언급'으로 치지 않는다(보고 5·4번).
  // 그런 토큰이 쓰기 프로그램·리다이렉트의 대상이면 아래에서 그대로 막고, 인터프리터 인자이면 그 조각만 민감하게 본다
  const unknownGlob = (a) => GLOB.test(a) && UNKNOWN_TARGET.test(a);
  // here-doc 본문(cat의 데이터, node·python의 코드)은 명령으로 나누지 않는다. 코드 본문은 그 인터프리터 조각에서 본다
  const { command: shell, bodies, code, data, codeBodies } = splitHeredocs(command);
  // 데이터 본문(cat·tee)에만 나온 보호 이름은 '언급'으로 치지 않는다(KI-02: 시험 스크립트를 cat으로 쓰고 node로 실행).
  // 그 본문을 같은 명령에서 실행할 수도 있으니, 인터프리터가 있으면 본문을 코드로 보고 보호 경로·알 수 없는 대상에 쓰면 막는다
  // 명령 부분(본문 뺀 것)의 언급은 그대로 친다. 임시 사본 경로 토큰만 뺀다(powershell -c "Set-Content …" 같은 쓰기를 놓치지 않게)
  // 와일드카드는 본문까지(셸 특수 변수는 빼고) 본다
  const mentionedIn = (sh) => {
    const s = [sh, ...bodies.filter((b) => b !== null)].join('\n').replace(/\$[?#$!@*0-9]/g, '');
    return mentionsProtected(sh) || codeBodies.some(mentionsProtected) || mentionsProtected(tokens(sh).filter((a) => !tempCopy(a, cwd)).join(' ')) || (GLOB.test(s) && tokens(s).some((a) => GLOB.test(a) && !UNKNOWN_TARGET.test(a) && riskyTarget(a, cwd)));
  };
  // 읽기 조각(quietReads)을 뺀 언급: 코드 인터프리터(node·python 등)를 따질지·strict만 이것으로 본다(설치본 읽기 + node 시험 실행 오탐).
  // 관문·.NET 호출·하위 셸(-c)·iex·링크 검사는 읽기 조각까지 친 언급으로 본다
  const quiet = quietReads(shell);
  const mentioned = mentionedIn(quiet.reduceRight((x, [a, b]) => x.slice(0, a) + 'true' + x.slice(b), shell));
  const mentionedAll = quiet.length ? mentionedIn(shell) : mentioned;
  // 본문을 실행할 수 없는 프로그램과 코드 인터프리터만 있을 때 통과. 그 밖(bash·. ·chmod 뒤 직접 실행·npx 등)은 보호 이름만 나와도 막는다
  // 맨 위 조각과 블록·하위 셸 안 조각(A1)은 한 번만 만든다. here-doc 본문은 맨 위 조각에만 짝짓는다
  const top = segments(shell);
  const segs = [...top, ...innerSegments(shell)];
  const progs = segs.map((s) => leadingTokens(s)[0]).filter(Boolean).map((p) => path.basename(p).toLowerCase().replace(/\.exe$/, ''));
  const runsOther = progs.some((p) => !CODE_INTERPRETERS.has(p) && !HEREDOC_SAFE.has(p));
  const runsCode = progs.some((p) => CODE_INTERPRETERS.has(p));
  if (data.some((b) => SOFT_NAMES.test(b.replace(/\\/g, '/').toLowerCase()) && (runsOther || (runsCode && codeWritesProtected(b, cwd, false))))) return true;
  // .claude·설치본 폴더를 가리키는 링크(임시 폴더에 만들어도): 그 링크로 쓰면 임시 사본 예외를 빠져나간다
  // 따옴표·이스케이프로 쪼갠 이름(.cl''aude)도 보고, 와일드카드·변수·중괄호·식이 든 링크는 대상을 모르니 막는다
  const LINK = /\b(?:junction|symboliclink|hardlink|mklink)\b|^\s*ln\s|\bcp\s(?:.*\s)?(?:-[A-Za-z]*[sl][A-Za-z]*|--(?:symbolic-)?link)(?=\s|$)/i;
  const linkSegs = segments(shell).filter((s) => LINK.test(s));
  if (linkSegs.some((s) => /\.claude\b|\.wy-tools/i.test(s.replace(/["'`\\^]/g, '')) || /[*?[$%{(`]/.test(s))) return true;
  // 같은 명령에서 링크를 만들고 보호 이름이 나오면(ln -s ~/proj /tmp/h && cp e /tmp/h/.claude/wy-ops.json) 임시 사본 예외를 믿을 수 없다
  if ((linkSegs.length || /symlink|\blink(?:Sync)?\s*\(|hardlink_to|CreateSymbolicLink|CreateHardLink/i.test(code + shell)) && (SOFT_NAMES.test(command.replace(/\\/g, '/').toLowerCase()) || mentionedAll)) return true;
  // 보호 폴더·파일 이름만 나와도(경로가 변수·명령 치환으로 쪼개진 경우: D=$(echo …/wy-approvals/ns); rm $D/decisions/a)
  // 아래 리다이렉트·쓰기 프로그램 검사는 한다. 그 검사는 대상이 보호 경로이거나 알 수 없는 값일 때만 막는다
  // .claude 아래 경로에 모르는 값($ ` %)이 든 토큰도 이름이 나온 것으로 본다(cp x ~/.claude/$f, KI-08)
  // 쓰기 대상이 접을 수 없는 PowerShell 식이면 보호 이름 조각(NAME_PIECES)만 나와도 이름이 나온 것으로 본다(A3)
  const writes = segs.flatMap((seg) => {
    const t = leadingTokens(seg);
    const prog = progName(t);
    return WRITERS.has(prog) ? writeArgs(prog, t.slice(1), seg) || t.slice(1) : [];
  });
  const named = SOFT_NAMES.test(command.replace(/\\/g, '/').toLowerCase()) || tokens(shell).some((a) => /\.claude[\\/]\S*[$`%]/i.test(a)) || (NAME_PIECES.test(command) && writes.some((a) => /^[(@]/.test(a)));
  // 리다이렉트(> >> 2> *>). =>(화살표 함수)·->·>=는 리다이렉트가 아니다
  const redirects = [...shell.matchAll(/(?<![=\-<])(?:\d|\*)?>{1,2}(?!=)\s*("[^"]*"|'[^']*'|[^\s|;&<>)]+)/g)].map((m) => m[1].replace(/^["']|["']$/g, '')).filter((a) => !NULL_TARGET.test(a));
  // 와일드카드 관문은 데이터 본문을 뺀 명령으로 본다(코드 본문은 남긴다: 코드 안 와일드카드 경로 우회를 그대로 잡게)
  if (!moved && !mentionedAll && !named && !GLOB.test(code.replace(/\$[?#$!@*0-9]/g, ''))) {
    // 앞 명령에서 만든 링크로 보호 폴더에 쓰는 것은 보호 이름이 안 나와도 막는다(KI-08). 하드링크·깨진 링크는 이름이 나올 때만 본다
    return [...redirects, ...writes].some((a) => linkIntoProtected(a, cwd));
  }
  for (const target of redirects) if (moved || riskyTarget(target, cwd)) return true;
  // 코드를 실행하는 것(.NET 호출·인터프리터)은 보호 경로가 언급되거나 보호 폴더로 이동한 명령에서만 따진다
  const sensitive = moved || mentioned;
  const sensitiveAll = moved || mentionedAll;
  for (const [k, seg] of segs.entries()) {
    const body = k < top.length && /<<-?\s*(['"]?)[A-Za-z_][\w-]*\1/.test(seg) ? bodies.shift() : null;
    const t = leadingTokens(seg);
    if (!t.length) continue;
    if (/^\[[\w.]+\]::/.test(t[0])) {
      // [IO.File]::ReadAllText 같은 읽기만 통과
      if (!sensitiveAll || (/^\[[\w.]+\]::(?:ReadAll|Exists)/i.test(t[0]) && !WRITE_API.test(seg))) continue;
      return true;
    }
    const prog = progName(t);
    const rest = t.slice(1);
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
    if (CODE_INTERPRETERS.has(prog) && (sensitive || named || rest.some(unknownGlob))) {
      // node·python 등은 쓰기 호출의 대상을 풀어 본다(다른 파일에 쓰면서 내용에 보호 경로 이름이 든 코드는 통과, 0.8.0).
      // 보호 폴더 이름만 나와도(path.join(…, 'wy-approvals', …, 'decisions')처럼 경로가 조각난 경우) 대상을 본다
      const strict = sensitive || rest.some(unknownGlob);
      if (codeWritesProtected([rest.join(' '), body || ''].join('\n'), cwd, strict)) return true;
    } else if (INTERPRETERS.has(prog) && (sensitiveAll || rest.some(unknownGlob))) {
      const code = rest.join(' ');
      if (WRITE_API.test(code) || OBFUSCATION.test(code) || !READ_API.test(code)) return true;
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

// rootOverride는 테스트용. 보통은 훅 입력의 cwd로 프로젝트 승인 폴더를 정한다
function evaluate(input, rootOverride) {
  const command = String((input.tool_input && input.tool_input.command) || '');
  if (!command) return null;
  if (writesApprovalFiles(command, input.cwd || process.cwd())) {
    return {
      decision: 'deny',
      reason: '승인 파일(~/.claude/wy-approvals 아래 decisions·decisions.log·used·sessions·message-blocks.log·.trust), 설치본(~/.wy-tools), 프로젝트 설정(.claude/wy-ops.json·wy-ops.local.json·settings.local.json)에는 셸 명령으로 쓸 수 없습니다. 읽기(cat·ls·tail·test)는 됩니다. 설정 변경은 내용을 pm 세션에 보내 사용자가 고치게 하세요.',
    };
  }
  const root = rootOverride || store.rootFor(input.cwd || process.cwd());
  const guarded = allSegments(command).map((s) => ({ segment: s, kind: classify(s) })).filter((g) => g.kind);
  if (!guarded.length) return null;
  const ops = loadOpsConfig(input.cwd || process.cwd());
  const COMMIT_SESSION = ops && typeof ops.commitRole === 'string' && ops.commitRole;
  if (!COMMIT_SESSION) {
    return { decision: 'deny', reason: `'${store.KINDS[guarded[0].kind]}' 명령은 커밋 역할만 실행합니다. 이 프로젝트의 .claude/wy-ops.json에 commitRole이 없습니다(install.ps1 init으로 만듭니다).` };
  }
  const ttlMinutes = Number(ops && ops.approvals && ops.approvals.ttlMinutes);
  const ttlMs = (ttlMinutes > 0 ? ttlMinutes : DEFAULT_TTL_MINUTES) * 60 * 1000;
  if (input.agent_type !== COMMIT_SESSION) {
    const who = input.agent_type || 'agent_type 없음';
    return { decision: 'deny', reason: `'${store.KINDS[guarded[0].kind]}' 명령은 ${COMMIT_SESSION}(--agent ${COMMIT_SESSION}로 실행한 세션)만 실행합니다(이 세션: ${who}). 커밋 요청은 ${COMMIT_SESSION}에 보내세요.` };
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
