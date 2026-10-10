#!/usr/bin/env node
// wy-ops 승인 가드(PreToolUse 훅, Bash·PowerShell). 초안 — 적용은 사용자 설정에서 한다.
// - 잠금 대상 git 명령: commit·push·강제 푸시·브랜치 생성/삭제·merge(gh pr merge)·reset·rebase·태그 삭제. 모두 승인 센터의 승인 결정이 있어야 한다.
// - 잠금 대상은 프로젝트 설정의 커밋 역할(wy-ops.json commitRole, agent_type)만 실행한다. agent_type이 없는 세션도, 설정이 없으면 모두 거부한다.
// - 승인 한 건은 한 번만 쓴다(used/<id>.json).
// - 승인 폴더는 훅 입력의 cwd가 속한 프로젝트의 것(~/.claude/wy-approvals/<namespace>, 설정이 없으면 바탕 폴더).
// - 승인 파일(decisions/·decisions.log·used/·sessions/·message-blocks.log), 설치본(~/.wy-tools), 프로젝트 설정(.claude/wy-ops.json·wy-ops.local.json·settings.local.json)에
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
// 보호 경로(소문자, / 구분자로 바꾼 명령에 대고 찾는다). 승인 파일은 바탕 폴더 바로 아래와 <namespace> 하위 모두
const PROTECTED = [
  /wy-approvals\/(?:[^/\s"'`]+\/)?(?:decisions|used\b|sessions\b|config\.json|message-blocks\.log)/,
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
  if (s === '~' || s.startsWith('~/')) s = os.homedir().replace(/\\/g, '/') + s.slice(1);
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

// 쓰기 대상이 보호 경로로 갈 수 있는지(직접 언급, 알 수 없는 값, 와일드카드를 펼친 결과)
function riskyTarget(arg, cwd) {
  if (mentionsProtected(arg) || UNKNOWN_TARGET.test(arg)) return true;
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

// 명령 안에 보호 폴더(또는 알 수 없는 곳)로 들어가는 이동이 있는지
function movesIntoProtected(command, cwd) {
  const segs = segments(command);
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
      if (into(a.replace(/\\/g, '/').toLowerCase()) || into(normDir(a)) || UNKNOWN_TARGET.test(a)) return true;
      if (!GLOB.test(a) && !a.startsWith('~') && into(normDir(path.resolve(cwd || process.cwd(), a)))) return true; // cwd 기준(.claude/jobs에서 cd ..)
      if (!GLOB.test(a)) return false;
      const hits = expandGlob(a, cwd);
      return !hits.length || hits.some(into); // 펼칠 수 없으면 알 수 없는 곳으로 본다
    });
  });
}

// 같은 명령 안에서 글자 그대로 정한 변수(S=/tmp/x, export S="…", $S = '…')와 홈 변수($HOME·${HOME}·$USERPROFILE·$env:USERPROFILE)를
// 값으로 바꾼다. 알 수 없는 대상으로 보던 오탐(S=/tmp/x; rm -rf $S)을 줄이고, 보호 경로를 변수에 담은 우회는 값이 드러나 잡힌다
function resolveVars(command) {
  const home = os.homedir().replace(/\\/g, '/');
  const vars = new Map([['HOME', home], ['USERPROFILE', home], ['env:USERPROFILE', home]]);
  const unq = (v) => v.replace(/^(["'])(.*)\1$/, '$2');
  // 값을 다시 정할 수 있는 변수(read·for·mapfile·getopts, 명령 치환 대입, 서로 다른 값 두 번)는 바꾸지 않는다 → 알 수 없는 대상으로 남는다
  const unsafe = new Set();
  for (const m of command.matchAll(/\b(?:read|mapfile|readarray)\b((?:\s+-\S+(?:\s+\S+)?)*)((?:\s+[A-Za-z_]\w*)+)/g)) for (const n of m[2].trim().split(/\s+/)) unsafe.add(n);
  for (const m of command.matchAll(/\b(?:for|select)\s+([A-Za-z_]\w*)\s+in\b|\bgetopts\s+\S+\s+([A-Za-z_]\w*)|\bforeach\s*\(\s*\$([A-Za-z_]\w*)/gi)) unsafe.add(m[1] || m[2] || m[3]);
  for (const m of command.matchAll(/(?:^|[;&|\n(\s])(?:export\s+|local\s+|declare\s+)?\$?([A-Za-z_]\w*)\s*\+?=\s*(?=[$`(])/g)) unsafe.add(m[1]);
  const set = (n, v) => (vars.has(n) && !['HOME', 'USERPROFILE', 'env:USERPROFILE'].includes(n) && vars.get(n) !== v ? unsafe.add(n) : vars.set(n, v));
  for (const m of command.matchAll(/(?:^|[;&|\n(]\s*)(?:export\s+|local\s+|declare\s+)?([A-Za-z_]\w*)=("[^"$`]*"|'[^']*'|[^\s;&|$`'"()]+)/g)) set(m[1], unq(m[2]));
  for (const m of command.matchAll(/(?:^|[;&|\n]\s*)\$([A-Za-z_]\w*)\s*=\s*("[^"$`]*"|'[^']*')/g)) set(m[1], unq(m[2]));
  for (const n of unsafe) vars.delete(n);
  let out = command;
  for (const [name, value] of vars) {
    const n = name.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
    out = out.replace(new RegExp(`\\$\\{${n}\\}|\\$${n}(?![\\w:])`, 'g'), () => value);
  }
  return out;
}

// ── 0.8.0 오탐 수정: here-doc 본문과 코드의 쓰기 대상 ──────────────────────────────
// 요청 폴더(requests/)는 세션이 카드를 쓰는 곳이라 보호 대상이 아니다(임시 이름 .part로 쓴 뒤 rename — README)
const REQUESTS_PATH = /wy-approvals\/(?:[^/\s"'`]+\/)?requests(?:\/|$)/;
// 본문을 명령으로 보지 않는 here-doc 소비자: 데이터를 받는 것(cat·tee)과 코드 인터프리터(본문은 그 코드로 따로 본다)
const HEREDOC_DATA = new Set(['cat', 'tee']);
const CODE_INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'perl', 'ruby', 'deno', 'bun']);

// here-doc 본문을 떼어 낸다. 셸(bash 등)이나 모르는 프로그램의 본문은 명령이므로 그대로 둔다.
//   돌려줌 { command: 본문을 뺀 명령, bodies: here-doc 머리 순서대로 본문(그대로 둔 것은 null),
//           code: 데이터 본문(cat·tee)만 뺀 명령 — 실행되지 않는 데이터의 ?·[·*를 와일드카드로 보지 않게(2026-10-10 pm 오탐) }
function splitHeredocs(command) {
  const lines = command.split('\n');
  const out = [];
  const code = [];
  const bodies = [];
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
    if (CODE_INTERPRETERS.has(prog)) code.push(...lines.slice(i + 1, end));
    i = end;
  }
  return { command: out.join('\n'), bodies, code: code.join('\n') };
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
  return args.length > 0 && READONLY_SUBCMDS.has(args[0]) && args.slice(1).every((a) => READONLY_FLAGS.has(a));
}
// 읽기 전용 CLI 조각을 아무것도 하지 않는 명령으로 바꾼다(나머지 조각은 그대로 판단)
function neutralizeReadOnlyCli(command) {
  let out = command;
  for (const seg of segments(command)) if (readOnlyCli(seg)) out = out.replace(seg, 'true');
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

// 보호 경로에 쓸 수 있는 명령인지 본다. 보호 경로가 나오는 명령에서
//  - 리다이렉트·쓰기 프로그램은 대상이 보호 경로이거나 알 수 없는 값(변수 등)일 때 막는다.
//    다른 파일에 쓰는 것은 통과(커밋 메시지 본문에 보호 파일 이름이 들어 있는 경우 등)
//  - 인터프리터는 코드가 읽기 API만 쓸 때만 통과시키고, 판단할 수 없으면 막는다
function writesApprovalFiles(command, cwd) {
  command = dataHereStrings(neutralizeReadOnlyCli(resolveVars(command)));
  // 보호 폴더로 cd 등을 했으면 그 뒤의 모든 쓰기(상대 경로)를 보호 경로 쓰기로 본다
  const moved = movesIntoProtected(command, cwd);
  // 와일드카드 인자를 펼쳐 보호 경로에 닿으면 보호 경로가 언급된 것으로 본다(인터프리터에 인자로 넘기는 우회 포함)
  // 셸 특수 변수($? $# $$ $! $@ $* $0~9)는 경로가 아니다. ?·*를 와일드카드로, $를 알 수 없는 대상으로 보던 오탐(echo "exit=$?", pm 보고)
  const scan = command.replace(/\$[?#$!@*0-9]/g, '');
  // 값을 알 수 없는 토큰(${PIPESTATUS[0]}, 따옴표 안 CSS의 /* */·% 등)은 '보호 경로 언급'으로 치지 않는다(보고 5·4번).
  // 그런 토큰이 쓰기 프로그램·리다이렉트의 대상이면 아래에서 그대로 막고, 인터프리터 인자이면 그 조각만 민감하게 본다
  const unknownGlob = (a) => GLOB.test(a) && UNKNOWN_TARGET.test(a);
  const mentioned = mentionsProtected(command) || (GLOB.test(scan) && tokens(scan).some((a) => GLOB.test(a) && !UNKNOWN_TARGET.test(a) && riskyTarget(a, cwd)));
  // 보호 폴더·파일 이름만 나와도(경로가 변수·명령 치환으로 쪼개진 경우: D=$(echo …/wy-approvals/ns); rm $D/decisions/a)
  // 아래 리다이렉트·쓰기 프로그램 검사는 한다. 그 검사는 대상이 보호 경로이거나 알 수 없는 값일 때만 막는다
  const named = SOFT_NAMES.test(command.replace(/\\/g, '/').toLowerCase());
  // here-doc 본문(cat의 데이터, node·python의 코드)은 명령으로 나누지 않는다. 코드 본문은 그 인터프리터 조각에서 본다
  const { command: shell, bodies, code } = splitHeredocs(command);
  // 와일드카드 관문은 데이터 본문을 뺀 명령으로 본다(코드 본문은 남긴다: 코드 안 와일드카드 경로 우회를 그대로 잡게)
  if (!moved && !mentioned && !named && !GLOB.test(code.replace(/\$[?#$!@*0-9]/g, ''))) return false;
  // 리다이렉트(> >> 2> *>). =>(화살표 함수)·->·>=는 리다이렉트가 아니다
  for (const m of shell.matchAll(/(?<![=\-<])(?:\d|\*)?>{1,2}(?!=)\s*("[^"]*"|'[^']*'|[^\s|;&<>)]+)/g)) {
    const target = m[1].replace(/^["']|["']$/g, '');
    if (NULL_TARGET.test(target)) continue;
    if (moved || riskyTarget(target, cwd)) return true;
  }
  for (const seg of segments(shell)) {
    const body = /<<-?\s*(['"]?)[A-Za-z_][\w-]*\1/.test(seg) ? bodies.shift() : null;
    const t = leadingTokens(seg);
    if (!t.length) continue;
    // 코드를 실행하는 것(.NET 호출·인터프리터)은 보호 경로가 언급되거나 보호 폴더로 이동한 명령에서만 따진다
    const sensitive = moved || mentioned;
    if (/^\[[\w.]+\]::/.test(t[0])) {
      // [IO.File]::ReadAllText 같은 읽기만 통과
      if (!sensitive || (/^\[[\w.]+\]::(?:ReadAll|Exists)/i.test(t[0]) && !WRITE_API.test(seg))) continue;
      return true;
    }
    const prog = path.basename(t[0]).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
    const rest = t.slice(1);
    // 쓰기 프로그램은 인자가 보호 경로로 갈 수 있을 때만 막는다(직접 언급·알 수 없는 값·와일드카드 펼친 결과)
    // PowerShell 내용 쓰기는 내용(데이터)을 빼고 대상 인자만 본다
    // 남은 here-string(내용 자리가 아니라 dataHereStrings가 그대로 둔 것)은 토큰으로 나눌 수 없으니 조각 전체로 본다
    const targets = CONTENT_WRITERS.has(prog) && !/@['"]\s*\n/.test(seg) ? contentArgs(rest).target : null;
    const risky = moved || (targets ? mentionsProtected(targets.join(' ')) || targets.some((a) => riskyTarget(a, cwd)) : mentionsProtected(seg) || rest.some((a) => riskyTarget(a, cwd)));
    if (WRITERS.has(prog) && risky) return true;
    // 문자열을 코드로 실행(파이프로 받는 iex): 실행할 코드가 앞 조각에 있으므로 명령 어디든 보호 이름이 나오면 막는다
    if ((prog === 'iex' || prog === 'invoke-expression') && (mentioned || named)) return true;
    if (prog === 'sed' && rest.some((a) => a.startsWith('-i') || a.startsWith('--in-place')) && (moved || mentionsProtected(seg) || sedFiles(rest).some((a) => riskyTarget(a, cwd)))) return true;
    if (prog === 'find' && risky && rest.some((a) => ['-delete', '-exec', '-execdir', '-ok'].includes(a))) return true;
    if (CODE_INTERPRETERS.has(prog) && (sensitive || named || rest.some(unknownGlob))) {
      // node·python 등은 쓰기 호출의 대상을 풀어 본다(다른 파일에 쓰면서 내용에 보호 경로 이름이 든 코드는 통과, 0.8.0).
      // 보호 폴더 이름만 나와도(path.join(…, 'wy-approvals', …, 'decisions')처럼 경로가 조각난 경우) 대상을 본다
      const strict = sensitive || rest.some(unknownGlob);
      if (codeWritesProtected([rest.join(' '), body || ''].join('\n'), cwd, strict)) return true;
    } else if (INTERPRETERS.has(prog) && (sensitive || rest.some(unknownGlob))) {
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
      reason: '승인 파일(~/.claude/wy-approvals 아래 decisions·decisions.log·used·sessions·message-blocks.log), 설치본(~/.wy-tools), 프로젝트 설정(.claude/wy-ops.json·wy-ops.local.json·settings.local.json)에는 셸 명령으로 쓸 수 없습니다. 읽기(cat·ls·tail·test)는 됩니다. 설정 변경은 내용을 pm 세션에 보내 사용자가 고치게 하세요.',
    };
  }
  const root = rootOverride || store.rootFor(input.cwd || process.cwd());
  const guarded = segments(command).map((s) => ({ segment: s, kind: classify(s) })).filter((g) => g.kind);
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
