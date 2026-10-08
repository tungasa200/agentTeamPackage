// 승인 가드 훅 쓰기 판단 검사: 보호 경로에 쓰는 명령은 거부, 읽기·다른 파일에 쓰기는 통과
//   node tools/wy-ops/vscode/test/guard.test.js
const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.WY_APPROVALS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-guard-'));
const { evaluate, classify, writesApprovalFiles } = require('../hooks/wy-approval-guard.js');

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('FAIL ' + m); } };
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-guard-proj-'));
// 와일드카드 검사용: 프로젝트 안에 보호 파일과 승인 폴더 모양을 만든다
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
fs.writeFileSync(path.join(proj, '.claude', 'wy-ops.json'), JSON.stringify({ commitRole: 'AB-commit' })); // 접두어가 WY-가 아닌 설정(범용화 회귀)
fs.mkdirSync(path.join(proj, 'h', '.claude', 'wy-approvals', 'erp-project', 'decisions'), { recursive: true });
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.writeFileSync(path.join(proj, 'src', 'a.log'), '');
const ev = (cmd) => evaluate({ tool_name: 'Bash', tool_input: { command: cmd }, agent_type: 'WY-backend2', cwd: proj, session_id: 's' });
const W = String.raw;
const NL = '\n';

const deny = [
  // 보호 경로에 직접 쓰기
  'echo x > .claude/wy-ops.json',
  'echo x >> C:/projects/erp-project/.claude/wy-ops.local.json',
  W`Set-Content .claude\settings.local.json '{}'`,
  'sed -i s/a/b/ .claude/wy-ops.json',
  'cp x .claude/settings.local.json',
  'rm -rf ~/.claude/wy-approvals/erp-project/used',
  'echo {} > ~/.claude/wy-approvals/erp-project/decisions/x.json',
  'echo x >> ~/.claude/wy-approvals/erp-project/decisions.log',
  'echo {} > ~/.claude/wy-approvals/decisions/x.json',
  // 세션 등록 기록(SessionStart 훅이 씀) — 역할 확인의 근거라 셸로 위조하지 못하게
  'echo {} > ~/.claude/wy-approvals/erp-project/sessions/s.json',
  // 메시지 거부 기록(메시지 가드 훅이 씀) — 세션 현황 경고의 근거
  'echo {} >> ~/.claude/wy-approvals/erp-project/message-blocks.log',
  // .claude 하위 폴더에서 ..로 거슬러 올라가기, .claude 자체로 이동
  'cd ~/.claude/jobs/x && echo {} > ../../wy-approvals/erp-project/decisions/a.json',
  'cd ~/.claude/jobs/x && cp a ../../settings.local.json',
  'cd ~/.claude && echo {} > wy-approvals/erp-project/decisions/a.json',
  // PowerShell 이동의 ..(WY-commit 검증), 정규화하면 .claude 자체인 경로
  'cd ~/.claude/jobs; Set-Location ..; Set-Content wy-ops.json 1',
  'cd ~/.claude/jobs; sl ..; Set-Content wy-ops.json 1',
  'cd ~/.claude/jobs; Push-Location ..; echo {} > wy-ops.json',
  'cd ~/.claude/./ && echo {} > wy-ops.json',
  'cd ~/.claude// && echo {} > settings.local.json',
  W`cd ~\.claude\ && echo {} > wy-ops.json`,
  // 같은 명령에서 정한 값이 read·for·명령 치환으로 다시 정해지면 값으로 보지 않는다
  'S=/tmp/x; read S; echo {} > $S/wy-ops.json',
  'S=/tmp/x; for S in a b; do echo {} > $S/wy-ops.json; done',
  'S=/tmp/x; S=$(pwd); echo {} > $S/settings.local.json',
  // 대상이 안 보이는 이동 뒤 상대 경로 쓰기(이전 상태에 기댐)
  'cd - && echo {} > wy-ops.json',
  'popd && echo {} > settings.local.json',
  'Pop-Location; Set-Content wy-ops.json 1',
  'Set-Location -; Set-Content wy-ops.json 1',
  // 경로를 변수·명령 치환으로 쪼갠 우회
  'D=~/.claude/wy-approvals/erp-project; rm -rf $D/decisions',
  'D=$(echo ~/.claude/wy-approvals/erp-project); rm $D/decisions/a.json',
  'S=a; T=$S/../.claude; echo > $T/wy-ops.json',
  'echo {} > $HOME/.claude/wy-approvals/erp-project/decisions/a.json',
  // 값을 알 수 없는 와일드카드를 인터프리터 인자로
  `node -e "require('fs').writeFileSync(process.argv[1],'{}')" \${X}*`,
  'cp a ~/.wy-tools/vscode-dashboard/x',
  W`[IO.File]::WriteAllText(".claude/wy-ops.json", "{}")`,
  // 인터프리터 쓰기 API·난독화
  `node -e "require('fs').writeFileSync('.claude/wy-ops.json','{}')"`,
  `node -e "const fs=require('fs');fs.writeFileSync(process.env.HOME+'/.claude/wy-approvals/erp-project/decisions/a.json','{}')"`,
  `node -e "require('fs').appendFileSync('.claude/settings.local.json','x')"`,
  `node -e "const f=require('fs');f['write'+'FileSync']('.claude/wy-ops.json','{}')"`,
  `node -e "require('fs').renameSync('x','.claude/wy-ops.json')"`,
  `python -c "open('.claude/settings.local.json','w').write('{}')"`,
  `python -c "import json;json.dump({},open('.claude/wy-ops.json',mode='a'))"`,
  `python -c "import os;os.remove('.claude/settings.local.json')"`,
  `python -c "getattr(__import__('os'),'remove')('.claude/wy-ops.json')"`,
  W`powershell -Command "Get-Content .claude/wy-ops.json | Set-Content .claude/wy-ops.local.json"`,
  `node -e "eval(atob('...'))" .claude/wy-ops.json`,
  `node .claude/wy-ops.json`,
  `bash -c "true" .claude/settings.local.json`,
  // 변수·알 수 없는 대상으로 우회
  W`$p='.claude/settings.local.json'; Set-Content $p '{}'`,
  W`$p = "C:\Users\k\.claude\wy-approvals\erp-project\decisions\a.json"; Out-File -FilePath $p -InputObject x`,
  'p=.claude/wy-ops.json; cp x $p',
  'f=.claude/wy-ops.json; echo {} > "$f"',
  'f=~/.claude/wy-approvals/erp-project/decisions/a.json; echo x > $(echo $f)',
  W`set P=.claude\wy-ops.json & echo x > %P%`,
  // 보호 폴더로 이동한 뒤 상대 경로로 쓰기(WY-commit 검증에서 찾은 우회)
  'cd ~/.claude/wy-approvals/erp-project/decisions && echo {} > x.json',
  'cd ~/.claude/wy-approvals/erp-project/decisions && cp a.json x.json',
  'Set-Location ~/.claude/wy-approvals/erp-project/decisions; Set-Content x.json 1',
  'pushd ~/.claude/wy-approvals/erp-project/used; touch x.json; popd',
  'cd .claude && echo {} > wy-ops.json',
  'cd ~/.wy-tools/vscode-dashboard/hooks && rm wy-approval-guard.js',
  W`sl C:\Users\k\.claude\wy-approvals\erp-project\decisions; ni x.json`,
  'd=~/.claude/wy-approvals/erp-project/decisions; cd $d && echo {} > x.json',
  // 와일드카드로 보호 경로를 숨기기(WY-commit 검증에서 찾음) — 실제로 펼쳐 보고 막는다
  'cd h/.cl*/wy-a*/erp-project/decisions && echo {} > x.json',
  'cd h/.claude/wy-*/*/dec* && cp a.json x.json',
  'cd nothing-here-*/zz? && echo {} > x.json',
  'echo {} > .cl*/wy-ops.json',
  'cp x .clau?e/wy-ops.json',
  'rm h/.claude/wy-app*/erp-project/decisions/*',
  // 와일드카드 인자를 인터프리터 쓰기 API로 넘기기(WY-commit 검증에서 찾음)
  `node -e "require('fs').writeFileSync(process.argv[1],'x')" h/.cl*/wy-a*/erp-project/decisions/a.json`,
  `python -c "import sys;open(sys.argv[1],'w').write('x')" .cl*/wy-ops.json`,
  `node -e "console.log(1)" h/.cl*/wy-a*/erp-project/decisions/a.json`,
  // 보호 파일이 나오는 명령에서 읽기 API가 없는 인터프리터 코드는 판단할 수 없어 막는다
  'cat .claude/settings.local.json | node -e "process.stdin.pipe(process.stdout)" > out.json',
  // sed: 스크립트가 아닌 파일 인자로 판단
  `sed -i 's/a/b/' .clau?e/wy-ops.json`,
  `F=.claude/wy-ops.json; sed -i -e 's/x$/y/' $F`,
  `sed --in-place=.bak 's/a/b/' .claude/wy-ops.json`, // WY-commit 검증에서 찾음
  // 특수 변수를 빼도 진짜 와일드카드 우회는 그대로 막는다
  `node -e "require('fs').writeFileSync(process.argv[1],'x')" h/.cl*/wy-a*/erp-project/decisions/a.json; echo $?`,
];
const allow = [
  // 읽기
  'cat .claude/wy-ops.json',
  'git add .claude/wy-ops.json .claude/settings.local.json',
  'git diff -- .claude/wy-ops.json',
  'Get-Content .claude/wy-ops.json',
  'Get-Content .claude/settings.local.json | ConvertFrom-Json',
  'Test-Path .claude/wy-ops.local.json',
  W`[IO.File]::ReadAllText("C:\projects\erp-project\.claude\wy-ops.json")`,
  'tail -n 0 -F ~/.claude/wy-approvals/erp-project/decisions.log',
  'until [ -f ~/.claude/wy-approvals/erp-project/decisions/x.json ]; do sleep 5; done; cat ~/.claude/wy-approvals/erp-project/decisions/x.json',
  'cat ~/.claude/wy-approvals/erp-project/decisions.log | tail -5',
  'ls -la ~/.claude/wy-approvals/erp-project/decisions/',
  'cat ~/.claude/wy-approvals/erp-project/sessions/s.json',
  'tail -5 ~/.claude/wy-approvals/erp-project/message-blocks.log',
  // 맨 끝의 되돌리기 이동은 막지 않는다
  'pushd /tmp && echo x > a.txt && popd',
  'Push-Location C:/tmp; Set-Content a.txt 1; Pop-Location',
  // 오탐 6건(WY-backend1·WY-backend2 보고, 2026-10-07): .claude의 다른 하위 폴더, ${PIPESTATUS[0]}, 같은 명령에서 정한 변수, 따옴표 안 CSS
  'cd "C:/Users/me/.claude/jobs/ed/tmp/b25" && node dom.js 2>&1 | grep -v NO_COLOR',
  'cd C:/Users/me/.claude/jobs/ed/tmp/b25 && sed -i "s#{ select } = {}#{ select, side } = {}#" build.js && node build.js',
  'mkdir -p ~/.claude/session-data && cat > ~/.claude/session-data/a.tmp <<\'EOF\'' + NL + 'x' + NL + 'EOF',
  'node --check a.js && for t in a b; do node test/$t.test.js 2>&1 | tail -2; echo "== $t ${PIPESTATUS[0]}"; done',
  'S=/tmp/wyb2chk; rm -rf $S; mkdir -p $S && git archive HEAD tools | tar -x -C $S && cd $S/tools && node test/a.test.js 2>&1 | tail -2',
  "python - <<'EOF'" + NL + "p='media/panel.css'" + NL + "s=io.open(p).read().replace('x', \"\"\"/* 꺼짐 */ .a { width: 50%; color: var(--dim); }\"\"\")" + NL + "io.open(p,'w').write(s)" + NL + 'EOF',
  'cat ~/.claude/wy-approvals/erp-project/decisions/a.json 2>/dev/null',
  'type .claude\\wy-ops.json',
  `node -e 'const d=require("C:/Users/k/.claude/wy-approvals/erp-project/decisions/20261007-x.json");console.log(d.decision, d.reason)'`,
  `python -c "import json;json.load(open('.claude/settings.local.json'))"`,
  `node -e "console.log(JSON.parse(require('fs').readFileSync('.claude/wy-ops.json','utf8')).roles.length)"`,
  `node -e "const d=require('./.claude/wy-ops.json');console.log(d.roles.map(r=>r.name).join())"`,
  `python3 -c "import json;print(json.load(open('.claude/wy-ops.json','r'))['project'])"`,
  W`powershell -Command "Get-Content .claude/wy-ops.json | ConvertFrom-Json"`,
  // 우리 스크립트 실행
  'powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/pm-ops/scripts/session.ps1 list',
  'node tools/wy-ops/gen-agents.js --check',
  'node tools/wy-ops/vscode/deploy.js',
  // 요청 파일 쓰기(보호 대상 아님)
  'echo {} > ~/.claude/wy-approvals/erp-project/requests/x.json',
  // 보호 파일을 읽어 다른 곳에 쓰기(B2-1 오탐 수정)
  'cat .claude/wy-ops.json > /tmp/copy.json',
  // WY-commit 커밋 메시지 파일: 본문에 보호 파일 이름이 들어 있어도 메시지 파일 쓰기는 통과(B2-1 오탐 수정)
  `cat > .git/WY_COMMIT_MSG <<'EOF'${NL}chore: .claude/wy-ops.json과 .claude/settings.local.json 설명 수정${NL}EOF`,
  `printf '%s\\n' "fix: ~/.claude/wy-approvals/erp-project/decisions 경로 안내" > .git/WY_COMMIT_MSG`,
  `echo "docs: .claude/wy-ops.local.json 언급 (a > b)" > C:/Users/k/AppData/Local/Temp/msg.txt`,
  `git commit -F .git/WY_COMMIT_MSG -m ".claude/wy-ops.json 정리"`,
  // 와일드카드가 보호 경로에 닿지 않으면 통과
  'rm src/*.log',
  'cp src/*.log /tmp/',
  'node build.js src/*.js',
  // 정규식에 쓰인 [ ](와일드카드 아님) — 배포본이 정규식 오류로 막던 것(WY-commit 결함 보고)
  `grep -nE "require\\(['\\"](jsdom|[a-z@][^./'\\"]*)['\\"]\\)" a.js | grep -vE "'(fs|os)'"`,
  `sed -n '/^\\[/p' notes.txt`,
  `rg "\\[(완료|차단)\\]" docs/`,
  `node -e "console.log(require('fs').readFileSync(process.argv[1],'utf8'))" .cl*/wy-ops.json`,
  'ls h/.cl*/wy-a*/erp-project/decisions',
  'cd src/* && echo x > out.txt',
  // sed 스크립트의 정규식 $ [ 는 대상이 아니다(WY-backend2 작업 중 오탐)
  `sed -i 's/^    this.roleWarnings = \\[\\];$/x/' approvalCenter.js`,
  `sed -i -e 's/[0-9]*$//' -e 's/^a/b/' src/a.log`,
  // Git Bash 드라이브 경로로 이동한 뒤 실행(WY-pm 보고)
  'cd /c/projects/erp-project && node tools/wy-ops/gen-skill.js',
  // 셸 특수 변수 $? 등은 와일드카드·알 수 없는 대상이 아니다(WY-pm 보고 원문)
  'cd /c/projects/erp-project && node tools/wy-ops/gen-skill.js && node tools/wy-ops/gen-skill.js --check; echo "exit=$?"',
  'node build.js; echo "$# $* $@ $1"',
  // 보호 폴더로 이동해 읽기만 하는 것은 통과
  'cd ~/.claude/wy-approvals/erp-project/decisions && cat x.json',
  'cd ~/.claude/wy-approvals/erp-project && ls decisions',
  'Set-Location ~/.claude/wy-approvals/erp-project/decisions; Get-Content x.json',
];
for (const c of deny) { const e = ev(c); ok(e && e.decision === 'deny', 'should deny: ' + c); }
// 설정에 commitRole이 없으면 기본 이름 없이 잠금 대상은 모두 거부(커밋 역할 이름으로 띄운 세션도)
{
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-guard-bare-'));
  fs.mkdirSync(path.join(bare, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(bare, '.claude', 'wy-ops.json'), '{}');
  const e = evaluate({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, agent_type: 'WY-commit', cwd: bare, session_id: 's' });
  ok(e && e.decision === 'deny' && e.reason.includes('commitRole이 없습니다'), 'commitRole 없음 → 거부: ' + JSON.stringify(e));
  const e2 = evaluate({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, agent_type: 'AB-qa', cwd: proj, session_id: 's' });
  ok(e2 && e2.decision === 'deny' && e2.reason.includes('AB-commit'), '다른 역할 → 설정의 커밋 역할 안내');
}
for (const c of allow) { const e = ev(c); ok(e === null || (c.startsWith('git commit') && e.reason.includes('AB-commit')), 'should allow: ' + c + ' → ' + JSON.stringify(e)); }

// cwd가 .claude 안일 때: 상대 경로·cd ..로 보호 파일에 닿으면 막고, 그 폴더 안 다른 파일은 통과
const jobs = path.join(proj, '.claude', 'jobs');
fs.mkdirSync(jobs, { recursive: true });
const inJobs = (cmd) => writesApprovalFiles(cmd, jobs);
ok(inJobs('cd .. && echo {} > wy-ops.json'), 'cwd .claude/jobs: cd .. 뒤 wy-ops.json');
ok(inJobs('Set-Location ..; Set-Content settings.local.json 1'), 'cwd .claude/jobs: Set-Location ..');
ok(inJobs('echo {} > ../wy-ops.json'), 'cwd .claude/jobs: ../wy-ops.json');
ok(writesApprovalFiles('echo {} > wy-ops.json', path.join(proj, '.claude')), 'cwd .claude: wy-ops.json');
ok(!inJobs('echo {} > a.json && sed -i s/a/b/ a.json'), 'cwd .claude/jobs: 그 안 파일은 통과');
ok(classify('git push -f origin x') === 'force-push' && classify('git status') === null && classify('git rebase --abort') === null, 'classify regression');
ok(ev('git push').decision === 'deny', 'non-commit session git push denied');
ok(writesApprovalFiles('ls') === false, 'unrelated passes');

// 세션 등록 기록에 실제 agent_type 덧쓰기(fork 세션은 SessionStart 기록이 null)
{
  const { noteAgentType } = require('../hooks/wy-approval-guard.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-note-'));
  const file = path.join(root, 'sessions', 'sess-fork-0001.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'sess-fork-0001', agentType: null, startedAt: 'x', source: 'fork' }));
  const a = noteAgentType({ session_id: 'sess-fork-0001', agent_type: 'WY-commit' }, root);
  const r1 = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(r1.agentTypeSeen === 'WY-commit' && r1.seenAt && r1.agentType === null && r1.source === 'fork', 'fork 기록에 실제 역할을 덧씀(시작 기록은 유지)');
  const m1 = fs.statSync(file).mtimeMs;
  noteAgentType({ session_id: 'sess-fork-0001', agent_type: 'WY-commit' }, root);
  ok(fs.statSync(file).mtimeMs === m1 && a.seenAt === JSON.parse(fs.readFileSync(file, 'utf8')).seenAt, '같은 값이면 다시 쓰지 않음');
  noteAgentType({ session_id: 'sess-fork-0001' }, root);
  ok(JSON.parse(fs.readFileSync(file, 'utf8')).agentTypeSeen === null, 'agent_type이 없으면 null로 바뀜');
  noteAgentType({ session_id: 'sess-new-00002', agent_type: 'WY-qa' }, root);
  ok(JSON.parse(fs.readFileSync(path.join(root, 'sessions', 'sess-new-00002.json'), 'utf8')).agentTypeSeen === 'WY-qa', '기록이 없으면 새로 만듦');
  ok(noteAgentType({ session_id: '../x' }, root) === null, '이상한 id는 쓰지 않음');
  fs.rmSync(root, { recursive: true, force: true });
}
fs.rmSync(proj, { recursive: true, force: true });
fs.rmSync(process.env.WY_APPROVALS_DIR, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : `guard 검사 통과 (거부 ${deny.length}, 통과 ${allow.length})`);
process.exit(fail ? 1 : 0);
