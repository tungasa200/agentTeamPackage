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
fs.mkdirSync(path.join(proj, 'h', '.claude', 'wy-approvals', 'my-project', 'decisions'), { recursive: true });
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.writeFileSync(path.join(proj, 'src', 'a.log'), '');
const ev = (cmd) => evaluate({ tool_name: 'Bash', tool_input: { command: cmd }, agent_type: 'WY-backend2', cwd: proj, session_id: 's' });
const W = String.raw;
const NL = '\n';
// 임시 폴더 안의 링크(junction): 저장소와 작업 폴더(proj)로 간다. 임시 사본 예외가 실제 경로를 보는지 시험
const tmpLink = path.join(os.tmpdir(), `wy-guard-link-${process.pid}`);
const tmpLinkCwd = path.join(os.tmpdir(), `wy-guard-linkcwd-${process.pid}`);
fs.symlinkSync(path.resolve(__dirname, '..', '..'), tmpLink, 'junction');
fs.symlinkSync(proj, tmpLinkCwd, 'junction');
// 앞 명령에서 만든 것으로 치는 링크(KI-02 2차): 하드링크 파일, 대상이 사라진 링크, 보호 폴더(.claude)로 가는 링크
fs.writeFileSync(path.join(proj, 'h1.txt'), '');
fs.linkSync(path.join(proj, 'h1.txt'), path.join(proj, 'h2.txt'));
const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-guard-gone-'));
const brokenLink = path.join(proj, 'broken');
fs.symlinkSync(gone, brokenLink, 'junction');
fs.rmSync(gone, { recursive: true, force: true });
const claudeLink = path.join(os.tmpdir(), `wy-guard-claudelink-${process.pid}`);
fs.symlinkSync(path.join(proj, '.claude'), claudeLink, 'junction');
// KI-08: 승인 결정 폴더로 가는 링크(보호 이름 없이 쓰기)
const decLink = path.join(os.tmpdir(), `wy-guard-declink-${process.pid}`);
fs.symlinkSync(path.join(proj, 'h', '.claude', 'wy-approvals', 'my-project', 'decisions'), decLink, 'junction');
const fwd = (p) => p.replace(/\\/g, '/');

const deny = [
  // 보호 경로에 직접 쓰기
  'echo x > .claude/wy-ops.json',
  'echo x >> C:/projects/my-project/.claude/wy-ops.local.json',
  W`Set-Content .claude\settings.local.json '{}'`,
  'sed -i s/a/b/ .claude/wy-ops.json',
  'cp x .claude/settings.local.json',
  'rm -rf ~/.claude/wy-approvals/my-project/used',
  'echo {} > ~/.claude/wy-approvals/my-project/decisions/x.json',
  'echo x >> ~/.claude/wy-approvals/my-project/decisions.log',
  'echo {} > ~/.claude/wy-approvals/decisions/x.json',
  // 세션 등록 기록(SessionStart 훅이 씀) — 역할 확인의 근거라 셸로 위조하지 못하게
  'echo {} > ~/.claude/wy-approvals/my-project/sessions/s.json',
  // 메시지 거부 기록(메시지 가드 훅이 씀) — 세션 현황 경고의 근거
  'echo {} >> ~/.claude/wy-approvals/my-project/message-blocks.log',
  // 기기 명부(바탕 폴더 .trust/, ENH-01) — 신뢰 진술·등록 요청을 셸로 위조하지 못하게
  'echo {} > ~/.claude/wy-approvals/.trust/devices.json',
  'rm -rf ~/.claude/wy-approvals/.trust',
  'rm ~/.claude/wy-approvals/.trust/join/x.json',
  'cp evil.json ~/.claude/wy-approvals/.trust/join/abc.json',
  `node -e "require('fs').writeFileSync(require('os').homedir() + '/.claude/wy-approvals/.trust/devices.json', '{}')"`,
  'cd ~/.claude/wy-approvals/.trust && echo {} > devices.json',
  // .claude 하위 폴더에서 ..로 거슬러 올라가기, .claude 자체로 이동
  'cd ~/.claude/jobs/x && echo {} > ../../wy-approvals/my-project/decisions/a.json',
  'cd ~/.claude/jobs/x && cp a ../../settings.local.json',
  'cd ~/.claude && echo {} > wy-approvals/my-project/decisions/a.json',
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
  'D=~/.claude/wy-approvals/my-project; rm -rf $D/decisions',
  'D=$(echo ~/.claude/wy-approvals/my-project); rm $D/decisions/a.json',
  'S=a; T=$S/../.claude; echo > $T/wy-ops.json',
  'echo {} > $HOME/.claude/wy-approvals/my-project/decisions/a.json',
  // 값을 알 수 없는 와일드카드를 인터프리터 인자로
  `node -e "require('fs').writeFileSync(process.argv[1],'{}')" \${X}*`,
  'cp a ~/.wy-tools/vscode-dashboard/x',
  W`[IO.File]::WriteAllText(".claude/wy-ops.json", "{}")`,
  // 인터프리터 쓰기 API·난독화
  `node -e "require('fs').writeFileSync('.claude/wy-ops.json','{}')"`,
  `node -e "const fs=require('fs');fs.writeFileSync(process.env.HOME+'/.claude/wy-approvals/my-project/decisions/a.json','{}')"`,
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
  W`$p = "C:\Users\k\.claude\wy-approvals\my-project\decisions\a.json"; Out-File -FilePath $p -InputObject x`,
  'p=.claude/wy-ops.json; cp x $p',
  'f=.claude/wy-ops.json; echo {} > "$f"',
  'f=~/.claude/wy-approvals/my-project/decisions/a.json; echo x > $(echo $f)',
  W`set P=.claude\wy-ops.json & echo x > %P%`,
  // 보호 폴더로 이동한 뒤 상대 경로로 쓰기(WY-commit 검증에서 찾은 우회)
  'cd ~/.claude/wy-approvals/my-project/decisions && echo {} > x.json',
  'cd ~/.claude/wy-approvals/my-project/decisions && cp a.json x.json',
  'Set-Location ~/.claude/wy-approvals/my-project/decisions; Set-Content x.json 1',
  'pushd ~/.claude/wy-approvals/my-project/used; touch x.json; popd',
  'cd .claude && echo {} > wy-ops.json',
  'cd ~/.wy-tools/vscode-dashboard/hooks && rm wy-approval-guard.js',
  W`sl C:\Users\k\.claude\wy-approvals\my-project\decisions; ni x.json`,
  'd=~/.claude/wy-approvals/my-project/decisions; cd $d && echo {} > x.json',
  // 와일드카드로 보호 경로를 숨기기(WY-commit 검증에서 찾음) — 실제로 펼쳐 보고 막는다
  'cd h/.cl*/wy-a*/my-project/decisions && echo {} > x.json',
  'cd h/.claude/wy-*/*/dec* && cp a.json x.json',
  'cd nothing-here-*/zz? && echo {} > x.json',
  'echo {} > .cl*/wy-ops.json',
  'cp x .clau?e/wy-ops.json',
  'rm h/.claude/wy-app*/my-project/decisions/*',
  // 와일드카드 인자를 인터프리터 쓰기 API로 넘기기(WY-commit 검증에서 찾음)
  `node -e "require('fs').writeFileSync(process.argv[1],'x')" h/.cl*/wy-a*/my-project/decisions/a.json`,
  `python -c "import sys;open(sys.argv[1],'w').write('x')" .cl*/wy-ops.json`,
  `node -e "console.log(1)" h/.cl*/wy-a*/my-project/decisions/a.json`,
  // 보호 파일이 나오는 명령에서 읽기 API가 없는 인터프리터 코드는 판단할 수 없어 막는다
  'cat .claude/settings.local.json | node -e "process.stdin.pipe(process.stdout)" > out.json',
  // sed: 스크립트가 아닌 파일 인자로 판단
  `sed -i 's/a/b/' .clau?e/wy-ops.json`,
  `F=.claude/wy-ops.json; sed -i -e 's/x$/y/' $F`,
  `sed --in-place=.bak 's/a/b/' .claude/wy-ops.json`, // WY-commit 검증에서 찾음
  // 특수 변수를 빼도 진짜 와일드카드 우회는 그대로 막는다
  `node -e "require('fs').writeFileSync(process.argv[1],'x')" h/.cl*/wy-a*/my-project/decisions/a.json; echo $?`,
  // 0.8.0: 코드의 쓰기 대상을 풀어 보는 판정 — 대상이 보호 경로이거나 풀 수 없으면 그대로 막는다
  `node -e "require('fs').writeFileSync(require('os').homedir()+'/.claude/wy-approvals/my-project/decisions/x.json','{}')"`,
  `node -e "const fs=require('fs');const d=require('os').homedir()+'/.claude/wy-approvals/my-project/requests/';fs.renameSync(d+'a.part',d+'../decisions/a.json')"`,
  `node -e "const fs=require('fs');const p=require('path').join(require('os').homedir(),'.claude','wy-approvals','my-project','used');fs.rmSync(p,{recursive:true})"`,
  `node -e "const fs=require('fs');fs.rmSync(require('os').homedir()+'/.claude/wy-approvals/my-project',{recursive:true})"`,
  `node -e "const w=require('fs').writeFileSync;w('x','.claude/wy-ops.json')"`,
  `node -e "require('fs')['writeFileSync']('a','~/.claude/wy-approvals/my-project/decisions')"`,
  `node -e "require('fs').writeFileSync(process.env.TARGET,'x')" # .claude/settings.local.json`,
  `node -e "const p='.claude/wy-ops.json';require('fs').writeFileSync(p,'{}')"`,
  `node -e "let p='docs/a.md';p+='/../../.claude/wy-ops.json';require('fs').writeFileSync(p,'{}')"`,
  `node -e "require('child_process').execSync('echo > .claude/settings.local.json')"`,
  `python - <<'EOF'${NL}from pathlib import Path${NL}p = Path.home() / '.claude' / 'wy-approvals' / 'my-project' / 'decisions' / 'x.json'${NL}p.write_text('{}')${NL}EOF`,
  `python - <<'EOF'${NL}import os${NL}os.replace('a.json', os.path.join(os.path.expanduser('~'), '.claude', 'wy-approvals', 'my-project', 'decisions', 'a.json'))${NL}EOF`,
  `python - <<'EOF'${NL}for p in ['.claude/wy-ops.json']:${NL}    open(p, 'w').write('{}')${NL}EOF`,
  `python3 - <<'EOF'${NL}import subprocess${NL}subprocess.run(['rm', '.claude/settings.local.json'])${NL}EOF`,
  `python - <<'EOF'${NL}import os${NL}fd = os.open('.claude/wy-ops.json', os.O_WRONLY)${NL}os.fdopen(fd, 'w').write('{}')${NL}EOF`,
  // cat here-doc이라도 리다이렉트 대상이 보호 경로면 막는다
  `cat >> .claude/wy-ops.json <<'EOF'${NL}{}${NL}EOF`,
  // 데이터 본문을 와일드카드 관문에서 빼도, 명령 쪽 와일드카드 대상은 그대로 펼쳐 막는다
  `cat > h/.cl*/wy-a*/my-project/decisions/a.json <<'EOF'${NL}{"a": [1]}${NL}EOF`,
  // 셸 here-doc 본문은 명령이므로 그대로 본다
  `bash <<'EOF'${NL}rm -rf ~/.claude/wy-approvals/my-project/decisions${NL}EOF`,
  // 요청 폴더로 이동해도 ..로 거슬러 오르거나, 요청 폴더가 아닌 승인 폴더로 이동하면 막는다
  'cd ~/.claude/wy-approvals/my-project/requests && mv a.part ../decisions/a.json',
  'cd ~/.claude/wy-approvals/my-project && mv requests/a.part decisions/a.json',
  // 2026-10-10: 설치본 CLI는 읽기 전용 하위 명령만 통과 — 쓰는 하위 명령·설치(--yes)·리디렉션·다른 형식은 그대로 막는다
  'powershell -NoProfile -ExecutionPolicy Bypass -File ~/.wy-tools/wy-ops/current/install.ps1 deploy',
  'powershell -File ~/.wy-tools/wy-ops/current/install.ps1 gen',
  W`& "$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1" host --dry-run`,
  'node ~/.wy-tools/wy-ops/current/lib/install.js connect h',
  'powershell -File ~/.wy-tools/wy-ops/current/install.ps1 doctor --yes',
  'powershell -File ~/.wy-tools/wy-ops/current/install.ps1 doctor > ~/.wy-tools/wy-ops/x.txt',
  'powershell -File ~/.wy-tools/wy-ops/current/install.ps1 doctor; rm -rf ~/.wy-tools/wy-ops/current',
  'powershell -Command "& ~/.wy-tools/wy-ops/current/install.ps1 doctor; Remove-Item ~/.wy-tools/x"',
  'node ~/.wy-tools/wy-ops/current/evil/install.js doctor',
  'powershell -File ~/.wy-tools/wy-ops/current/install.ps1 doctor $(rm ~/.wy-tools/x)',
  // PowerShell here-string: 내용 자리가 아닌 곳(경로·변수·코드 실행)은 그대로 본다
  `Set-Content @'${NL}.claude/wy-ops.json${NL}'@ x`,
  `$t = @'${NL}.claude/wy-ops.json${NL}'@${NL}Set-Content $t x`,
  `@'${NL}Remove-Item .claude/wy-ops.json${NL}'@ | iex`,
  `Add-Content .claude/wy-ops.json @'${NL}x${NL}'@`,
  `Set-Content -Value @'${NL}x${NL}'@ -Path .claude/settings.local.json`,
  // 내용 쓰기: 대상(첫 위치 인자·-Path·-FilePath)이 보호 경로이거나 알 수 없는 값이면 내용과 상관없이 막는다
  'Add-Content .claude/wy-ops.json "docs 메모"',
  'Set-Content -Value "{}" -LiteralPath .claude/settings.local.json',
  'Out-File -InputObject x -FilePath:.claude/wy-ops.json',
  'Add-Content $p "- .claude/wy-ops.json 정리"',
  // KI-02 수정의 경계: 임시 사본 예외·복사 대상·변수 풀이·doctor --project·데이터 본문 실행
  W`S="$env:TEMP\..\x\.claude"; Copy-Item a "$S\wy-ops.json"`,
  `$env:TEMP = 'C:/Users/k/.claude'; Set-Location $env:TEMP; Set-Content wy-ops.json 1`,
  W`[Environment]::SetEnvironmentVariable('TEMP', 'C:\Users\k\.claude'); Set-Location $env:TEMP; Set-Content wy-ops.json 1`,
  'TMP=~/.claude; cd $TMP && echo {} > wy-ops.json',
  `S="$(pwd)/.claude"; cp a "$S/wy-ops.json"`,
  'cp a.json /tmp/x/.claude/wy-approvals/my-project/decisions/a.json',
  'cp a.json /tmp/x/../../.claude/wy-ops.json',
  `cp a.json ${proj.replace(/\\/g, '/')}/.claude/wy-ops.json`,
  'Copy-Item -Destination .claude/wy-ops.json a.json',
  'Copy-Item a.json -Destination:.claude/settings.local.json',
  'cp -t .claude wy-ops.json',
  'cp .claude/wy-ops.json /tmp/c1/x.json; rm .claude/wy-ops.json',
  'node ~/.wy-tools/wy-ops/current/lib/install.js doctor --project',
  'node ~/.wy-tools/wy-ops/current/lib/install.js doctor --project . --yes',
  `cat > /tmp/w.sh <<'EOF'${NL}echo {} > ~/.claude/wy-approvals/my-project/decisions/a.json${NL}EOF${NL}bash /tmp/w.sh`,
  `cat <<'EOF' | bash${NL}echo {} > ~/.claude/wy-approvals/my-project/decisions/a.json${NL}EOF`,
  `cat <<'EOF' > /tmp/w.sh${NL}echo {} > ~/.claude/wy-approvals/my-project/decisions/a.json${NL}EOF${NL}. /tmp/w.sh`,
  'New-Item -ItemType Junction -Path $env:TEMP/j -Target ~/.claude/wy-approvals',
  'ln -s ~/.claude/wy-approvals /tmp/j',
  'cmd /c mklink /J C:\\tmp\\j C:\\Users\\k\\.claude\\wy-approvals',
  'cp wy-ops.json .claude/',
  'cp /tmp/c1/.claude/wy-ops.json .claude/',
  'copy /Y /tmp/c1/.claude/wy-ops.json .claude',
  'Copy-Item /tmp/c1/.claude/wy-ops.json -Destination .claude',
  'Copy-Item a.json -Destination /tmp/c1/x.json, .claude/wy-ops.json',
  'Set-Content /tmp/c1/x,.claude/wy-ops.json 1',
  'TMP+=/../../../../../projects/x; cp a $TMP/.claude/wy-ops.json',
  'printf -v TMP %s /c/projects/x; cp a $TMP/.claude/wy-ops.json',
  `$env:TEMP += '/../..'; Copy-Item a $env:TEMP/.claude/wy-ops.json`,
  `$e='env:TEMP'; Set-Item $e C:/projects/x; Copy-Item a $env:TEMP/.claude/wy-ops.json`,
  'node ~/.wy-tools/wy-ops/current/lib/install.js doctor --project --yes',
  'node ~/.wy-tools/wy-ops/current/lib/install.js help --project deploy',
  `cat > /tmp/w.js <<'EOF'${NL}require('fs').writeFileSync('.claude/wy-ops.json','1')${NL}EOF${NL}chmod +x /tmp/w.js; /tmp/w.js`,
  `cat > /tmp/w.js <<'EOF'${NL}require('fs').writeFileSync(require('path').join(require('os').homedir(),'.claude','wy-approvals','my-project','decisions','a.json'),'{}')${NL}EOF${NL}node /tmp/w.js`,
  'Copy-Item settings.local.json .claude/',
  'Copy-Item a.json,wy-ops.json -Destination .claude',
  `cat > /tmp/w.js <<'EOF'${NL}require('fs').writeFileSync(require('os').homedir()+'/.claude/wy-approvals/my-project/decisions/a.json','{}')${NL}EOF${NL}node /tmp/w.js`,
  // KI-02 보안 점검: 명령 부분의 보호 경로 언급, 같은 명령의 링크, 앞서 만든 링크(임시 폴더 → 프로젝트)
  'ln -s ~/proj /tmp/h && cp e.json /tmp/h/.claude/wy-ops.json',
  'cp -rs ~/proj /tmp/h && cp e.json /tmp/h/.claude/wy-ops.json',
  `ln -s ~/.cl''aude /tmp/h`,
  'ln -s ~/.cla?de /tmp/h',
  `node -e "require('fs').symlinkSync('C:/proj','/tmp/h')" && cp e.json /tmp/h/.claude/wy-ops.json`,
  `cp e.json ${fwd(tmpLinkCwd)}/.claude/wy-ops.json`,
  // KI-02 2차: 이미 있는 하드링크·깨진 링크·링크를 지나 보호 폴더로 가는 쓰기, Join-Path가 보호 경로를 만드는 경우, PowerShell 식 인자
  'cat .claude/wy-ops.json > h2.txt',
  'cp .claude/wy-ops.json broken/x.json',
  `cat .claude/wy-ops.json > ${fwd(claudeLink)}/settings.local.json`,
  `cd ${fwd(claudeLink)} && echo {} > x.json && cat ../.claude/wy-ops.json`,
  '$S = Join-Path $HOME .claude/wy-ops.json; Set-Content $S 1',
  '$S = Join-Path $X c1; Set-Content $S/wy-ops.json 1',
  'Copy-Item .claude/wy-ops.json (Get-Item x)',
  W`$S = "$env:TEMP\c1"; $S = (Join-Path $HOME '.claude') + '\wy-ops.json'; Set-Content $S 1`,
  `$S = Join-Path $env:TEMP c1; $s = '~/.claude'; Set-Content $S/wy-ops.json 1`,
  'mktemp() { echo ~/.claude; }; S=$(mktemp -d); cp x $S/wy-ops.json',
  // KI-08: 글자 목록 반복 변수, .claude 아래 모르는 값, 앞 명령에서 만든 링크(보호 이름 없이)
  'for f in wy-ops.json; do cp x .claude/$f; done',
  'for f in ~/.claude/wy-ops.json; do cp x $f; done',
  'for f in a.json wy-ops.json; do cp x ".claude/${f}"; done',
  'D=/tmp/c1; for f in wy-ops.json; do f=~/.claude/wy-ops.json; cp x $f; done',
  'cp x .claude/$f; for f in a; do echo $f; done',
  'for f in $(ls); do cp x ~/.claude/$f; done',
  'cp x ~/.claude/$f',
  'cp x ~/.claude/wy-$n',
  `echo {} > ${fwd(decLink)}/a.json`,
  `cp x.json ${fwd(decLink)}/a.json`,
  `Set-Content ${fwd(decLink)}/a.json 1`,
  'mktemp() { echo ~/.claude; }; cd "$(mktemp -d)" && echo {} > wy-ops.json',
  'cat ~/.wy-tools/x/package.json | node',
  'cat ~/.wy-tools/x/install.ps1 > ~/.wy-tools/x/b.ps1',
  // KI-08 점검에서 찾은 퇴행: 읽기 조각 뒤의 .NET 쓰기·하위 셸, 반복 변수 재정의, cd·pushd 재정의, rg --pre
  "cat ~/.claude/wy-ops.json; [IO.File]::WriteAllText($p, 'x')",
  'cat ~/.claude/wy-ops.json; bash -c "$x"',
  'cat ~/.claude/wy-ops.json; powershell -c "$x"',
  'for f in a.json; do unset f; cp x ~/.claude/$f; done',
  "foreach ($f in 'a.json') { ${f} = 'wy-ops.json'; Copy-Item x .claude/$f }",
  'for f in a.json; do : ${f:=x}; cp x ~/.claude/$f; done',
  "foreach ($f in 'a.json') { $f, $g = 'wy-ops.json', 1; Copy-Item x .claude/$f }",
  "foreach ($f in 'a.json') { Remove-Variable f; Copy-Item x .claude/$f }",
  "foreach ($f in 'a.json') { Set-Item variable:f 'wy-ops.json'; Copy-Item x .claude/$f }",
  "foreach ($f in 'a.json') { Set-It ([ref]$f); Copy-Item x .claude/$f }",
  'cd() { builtin cd ~/.claude; }; cd "$(mktemp -d)" && echo {} > wy-ops.json',
  "alias cd='cd ~/.claude'; cd \"$(mktemp -d)\" && echo {} > wy-ops.json",
  'pushd() { builtin cd ~/.claude; }; pushd "$(mktemp -d)" && echo {} > wy-ops.json',
  'rg --pre ./w.sh x ~/.claude/wy-ops.json && node a.js',
  // 반복 헤더가 실행 자리가 아님(따옴표·here-doc·단락 조건·함수·if 안), 이름을 변수에 담은 대입, source·. 로 불러온 파일
  'cat ~/.claude/wy-ops.json; echo "for f in a.json; do"; cp x $f',
  'cat ~/.claude/wy-ops.json; cat <<E\nfor f in a.json; do\nE\ncp x $f',
  'cat ~/.claude/wy-ops.json; false && for f in a.json; do :; done; cp x $f',
  'cat ~/.claude/wy-ops.json; g() { for f in a.json; do :; done; }; cp x $f',
  'if false; then for f in a.json; do :; done; fi; cp x ~/.claude/$f',
  "function g { foreach ($f in 'a.json') { } }; Copy-Item x .claude/$f",
  "v=$(printf '\\x66'); for f in a.json; do printf -v \"$v\" %s wy-ops.json; cp x ~/.claude/$f; done",
  "v=$(printf '\\x66'); for f in a.json; do read \"$v\" <<< wy-ops.json; cp x ~/.claude/$f; done",
  "v=$(printf '\\x66'); for f in a.json; do declare \"$v=wy-ops.json\"; cp x ~/.claude/$f; done",
  "$v = [string][char]102; foreach ($f in 'a.json') { Set-Variable -Name $v -Value 'wy-ops.json'; Copy-Item x .claude/$f }",
  '. ./r.sh; cd "$(mktemp -d)" && echo {} > wy-ops.json',
  'source ./r.sh; cd "$(mktemp -d)" && echo {} > wy-ops.json',
  'cat ~/.claude/wy-ops.json; for f in a.json; do source ./r.sh; cp x $f; done',
  "foreach ($f in 'a.json') { . ./r.ps1; Copy-Item x .claude/$f }",
  // KI-08 A1: 블록·하위 셸·명령 치환 안의 쓰기와 잠금 명령
  "foreach ($f in 'wy-ops.json') { Copy-Item x .claude/$f }",
  'if (1) { Remove-Item ~/.claude/wy-ops.json }',
  'ls | ForEach-Object { Remove-Item ~/.claude/wy-ops.json }',
  '(rm ~/.claude/wy-ops.json)',
  'f() { rm ~/.claude/wy-ops.json; }; f',
  'try { Set-Content ~/.claude/wy-ops.json 1 } catch {}',
  '$(rm ~/.claude/wy-ops.json)',
  'echo `rm ~/.claude/wy-ops.json`',
  'x=$(rm ~/.claude/wy-ops.json)',
  'echo "$(rm ~/.claude/wy-ops.json)"',
  '(cd ~/.claude && rm wy-ops.json)',
  '(git push)',
  '{ git commit -m x; }',
  // 읽기 전용 CLI로 바꾸는 자리는 조각 경계에서만(같은 글자로 시작하는 다른 조각)
  '& ~/.wy-tools/wy-ops/current/install.ps1 doctor --yes; & ~/.wy-tools/wy-ops/current/install.ps1 doctor',
  // KI-08 A3: PowerShell 식 인자(글자 이어 붙이기는 접고, 접을 수 없는 식은 이름 조각이 있으면 막는다)
  "Set-Content (('~/.claude/wy-' + 'ops') + '.json') 1",
  "Set-Content (\"{0}{1}\" -f '~/.cl', 'aude/wy-ops.js' + 'on') 1",
  "Remove-Item ('~/.cl' + \"aude/wy-\" + 'approvals/x/deci' + 'sions') -Recurse",
  "New-Item -ItemType File (('~/.cl' + 'aude/settings.lo') + 'cal.json')",
  "if ($true) { Remove-Item ('~/.cl' + 'aude/wy-ops.json') }",
  // security-review: 조각 맨 앞의 ( )(bash 하위 셸)는 접지 않는다, 두 따옴표가 다 든 값은 접지 않는다
  "( 'rm' + '.claude/wy-ops.json' )",
  "x=1 && ( 'mv' + '.claude/wy-ops.json' )",
  "Write-Output ('a\"' + \"'b\"); Remove-Item .claude/wy-ops.json",
  "echo ('a\"' + \"'b\") ; rm .claude/wy-ops.json",
  // D-35: 이름은 다른 조각에 있어도 값 모르는 인자·파이프로 흘러오면, 따옴표·^로 쪼갠 이름이 하위 셸 문자열에 있으면 막는다
  `cat .claude/wy-ops.json; node -e "require('fs').writeFileSync(process.argv[1],'x')" $P`,
  `Get-Content .claude/wy-ops.json | node -e "require('fs').writeFileSync('.cl'+'aude/wy-ops.json','y')"`,
  `ls ~/.wy-tools; bash -c 'cd ~/.wy-to""ols && rm -rf x'`,
  `ls .claude; bash -c 'rm -f .cl""aude/wy-o""ps.json'`,
  W`ls .claude; cmd /c "del .cl^aude\wy-o^ps.json"`,
  "cd $D; bash -c 'rm a'",
  // D-35 리뷰: 보호 이름을 담은 스크립트·목록 파일을 다른 조각에서 만들고 실행, 대상이 식인 .NET 쓰기, bash 변수 true, 따옴표 경로 링크 프로그램
  `echo "require('fs').writeFileSync('.claude/wy-ops.json','{}')" > /tmp/a.js; node /tmp/a.js`,
  `printf '%s' "open('.claude/wy-ops.json','w').write('x')" > /tmp/a.py; python /tmp/a.py`,
  "Set-Content -Path C:/tmp/a.ps1 -Value 'Set-Content .claude/wy-ops.json x'; powershell -File C:/tmp/a.ps1",
  "echo .claude/wy-ops.json > /tmp/l; [IO.File]::WriteAllText((Get-Content /tmp/l), 'x')",
  'true=$(cat /tmp/l); rm "$true"; echo .claude/wy-ops.json',
  '"C:/Sys Tools/junction.exe" /tmp/h ~/proj; cp e /tmp/h/.claude/wy-ops.json',
  // 셸 인터프리터는 이름이 다른 조각에만 있어도 본다(-c 안 와일드카드, 표준 입력·스크립트 파일), 따옴표 문자열 안 $(…)의 링크
  "cat .claude/wy-ops.json; bash -c 'rm -f .cl[a]ude/wy-o[p]s.json'",
  'cat .claude/wy-ops.json; cat /tmp/p | bash',
  'cat .claude/wy-ops.json; bash /tmp/evil.sh',
  W`"a b $(New-Item -ItemType Junction -Path C:\tmp\j -Target .claude) c"; Copy-Item C:\tmp\x C:\tmp\j\wy-ops.json`,
  // TOK-6 리뷰: cmd /c dir 뒤에 이어 붙인 명령, 펼칠 수 없는 와일드카드 경로(-c 문자열 안), 명령 치환으로 부른 링크 프로그램
  W`ls ~\.claude\wy-approvals\my-project\decisions; cmd /c dir ^& x.bat`,
  'ls ~/.claude/wy-approvals/my-project/decisions; cmd /c "dir | x.bat"',
  "bash -c 'cp e.json ~/.cl?ude/wy-a*/my-project/decisions/new.json'",
  'pwsh -c "Copy-Item e.json C:/Users/x/.cl?ude/wy-a*/my-project/decisions/"',
  '"$(command -v ln)" -s ~/.claude/wy-approvals/my-project /tmp/h',
  // D-35 code-review: 값 모르는 cd 대상의 보호 이름, 코드가 안 보이는 플래그(-E·-p·-r)·load로 부른 파일, 대입·Set-Variable로 담은 이름
  'cd "$(dirname ~/.claude/wy-ops.json)"; python w.py',
  'cd $(echo ~/.cl""aude); python w.py',
  `cd "$(dirname ~/.claude/wy-ops.json)"; node -e "require('fs').writeFileSync('wy-ops.json','x')"`,
  `echo "open('.claude/wy-ops.json','w').write('x')" > /tmp/a.py; python -E /tmp/a.py`,
  `echo "File.write('.claude/wy-ops.json','x')" > /tmp/a.rb; ruby -p /tmp/a.rb`,
  `echo "require('fs').writeFileSync('.claude/wy-ops.json','x')" > /tmp/a.js; node -r /tmp/a.js -e 1`,
  `echo "File.write('.claude/wy-ops.json','x')" > /tmp/a.rb; ruby -e 'load "/tmp/a.rb"'`,
  `$f = '.claude/wy-ops.json'; perl -e 'do "/tmp/x.pl"'`,
  'Get-Content .claude/wy-ops.json | Set-Variable p; python /tmp/w.py',
];
const allow = [
  // 읽기
  'cat .claude/wy-ops.json',
  'git add .claude/wy-ops.json .claude/settings.local.json',
  'git diff -- .claude/wy-ops.json',
  'Get-Content .claude/wy-ops.json',
  'Get-Content .claude/settings.local.json | ConvertFrom-Json',
  'Test-Path .claude/wy-ops.local.json',
  W`[IO.File]::ReadAllText("C:\projects\my-project\.claude\wy-ops.json")`,
  'tail -n 0 -F ~/.claude/wy-approvals/my-project/decisions.log',
  'until [ -f ~/.claude/wy-approvals/my-project/decisions/x.json ]; do sleep 5; done; cat ~/.claude/wy-approvals/my-project/decisions/x.json',
  'cat ~/.claude/wy-approvals/my-project/decisions.log | tail -5',
  'ls -la ~/.claude/wy-approvals/my-project/decisions/',
  'cat ~/.claude/wy-approvals/my-project/sessions/s.json',
  'tail -5 ~/.claude/wy-approvals/my-project/message-blocks.log',
  'cat ~/.claude/wy-approvals/.trust/devices.json',
  'ls -la ~/.claude/wy-approvals/.trust/join/',
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
  'cat ~/.claude/wy-approvals/my-project/decisions/a.json 2>/dev/null',
  'type .claude\\wy-ops.json',
  `node -e 'const d=require("C:/Users/k/.claude/wy-approvals/my-project/decisions/20261007-x.json");console.log(d.decision, d.reason)'`,
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
  'echo {} > ~/.claude/wy-approvals/my-project/requests/x.json',
  // 보호 파일을 읽어 다른 곳에 쓰기(B2-1 오탐 수정)
  'cat .claude/wy-ops.json > /tmp/copy.json',
  // WY-commit 커밋 메시지 파일: 본문에 보호 파일 이름이 들어 있어도 메시지 파일 쓰기는 통과(B2-1 오탐 수정)
  `cat > .git/WY_COMMIT_MSG <<'EOF'${NL}chore: .claude/wy-ops.json과 .claude/settings.local.json 설명 수정${NL}EOF`,
  `printf '%s\\n' "fix: ~/.claude/wy-approvals/my-project/decisions 경로 안내" > .git/WY_COMMIT_MSG`,
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
  'ls h/.cl*/wy-a*/my-project/decisions',
  'cd src/* && echo x > out.txt',
  // sed 스크립트의 정규식 $ [ 는 대상이 아니다(WY-backend2 작업 중 오탐)
  `sed -i 's/^    this.roleWarnings = \\[\\];$/x/' approvalCenter.js`,
  `sed -i -e 's/[0-9]*$//' -e 's/^a/b/' src/a.log`,
  // Git Bash 드라이브 경로로 이동한 뒤 실행(WY-pm 보고)
  'cd /c/projects/my-project && node tools/wy-ops/gen-skill.js',
  // 셸 특수 변수 $? 등은 와일드카드·알 수 없는 대상이 아니다(WY-pm 보고 원문)
  'cd /c/projects/my-project && node tools/wy-ops/gen-skill.js && node tools/wy-ops/gen-skill.js --check; echo "exit=$?"',
  'node build.js; echo "$# $* $@ $1"',
  // 보호 폴더로 이동해 읽기만 하는 것은 통과
  'cd ~/.claude/wy-approvals/my-project/decisions && cat x.json',
  'cd ~/.claude/wy-approvals/my-project && ls decisions',
  'Set-Location ~/.claude/wy-approvals/my-project/decisions; Get-Content x.json',
  // 0.8.0 오탐 수정(pm 보고): 다른 파일에 쓰는 코드의 내용에 보호 경로 이름이 든 경우, 읽기, 요청 폴더 쓰기
  `python - <<'EOF'${NL}with open('docs/결정기록.md', 'a', encoding='utf-8') as f:${NL}    f.write('- D-163 승인 파일(~/.claude/wy-approvals/<ns>/decisions/)·settings.local.json은 확장·사용자만 쓴다\\n')${NL}EOF`,
  `powershell -NoProfile -Command "Select-String -Path C:\\projects\\p\\.claude\\settings.local.json -Pattern 'hooks'"`,
  W`Select-String -Path .claude\settings.local.json -Pattern 'wy-(approval|decision)' | ForEach-Object { $_.Line }`,
  `node -e "const fs=require('fs');const d=require('os').homedir()+'/.claude/wy-approvals/my-project/requests/';fs.writeFileSync(d+'1.json.part',JSON.stringify({kind:'commit',files:['.claude/settings.local.json','x/decisions.log']}));fs.renameSync(d+'1.json.part',d+'1.json')"`,
  `node -e "const fs=require('fs'),path=require('path');const d=path.join(require('os').homedir(),'.claude','wy-approvals','my-project','requests');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'a.part'),'{}');fs.renameSync(path.join(d,'a.part'),path.join(d,'a.json'))"`,
  `python - <<'EOF'${NL}import os, json${NL}from pathlib import Path${NL}d = Path.home() / '.claude' / 'wy-approvals' / 'my-project' / 'requests'${NL}tmp = d / 'a.json.part'${NL}tmp.write_text(json.dumps({'why': 'decisions·used 오탐'}), encoding='utf-8')${NL}os.replace(tmp, d / 'a.json')${NL}EOF`,
  'cd ~/.claude/wy-approvals/my-project/requests && mv tmp-a.json.part 20261010-a.json',
  `cat > ~/.claude/wy-approvals/my-project/requests/a.json.part <<'EOF'${NL}{"kind":"commit","why":"decisions 폴더와 settings.local.json 오탐 수정 > 다음"}${NL}EOF${NL}mv ~/.claude/wy-approvals/my-project/requests/a.json.part ~/.claude/wy-approvals/my-project/requests/a.json`,
  `node -e "const s=require('fs').readFileSync('.claude/wy-ops.json','utf8');process.stdout.write(s.replace('a','b'))"`,
  // pm 보고: 문서에 덧붙이는 cat here-doc. 본문(데이터)에 보호 이름·리다이렉트·쓰기 명령 글자가 있어도 대상(docs/…)만 본다
  `cat >> docs/진행현황.md <<'EOF'${NL}- wy-ops.json·sessions 정리: rm ~/.claude/wy-approvals/my-project/sessions/x.json > .claude/settings.local.json${NL}EOF`,
  // pm 보고(2026-10-10): 작업 폴더 변수로 스크립트를 쓰는 cat here-doc. 데이터 본문의 ?.·[]를 와일드카드로 보고 변수 대상을 막던 오탐
  `cat > "$CLAUDE_JOB_DIR/tmp/cdpshot.mjs" <<'EOF'${NL}const r = await send('Target.attachToTarget', { targetId: t.id });${NL}const sessionId = r?.sessionId;${NL}console.log(arr[0]);${NL}EOF`,
  // pm 보고(2026-10-10): 설치본의 읽기 전용 하위 명령(doctor·도움말)은 경로가 보호 폴더여도 통과
  'powershell -NoProfile -ExecutionPolicy Bypass -File ~/.wy-tools/wy-ops/current/install.ps1 doctor',
  W`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1" doctor --json`,
  W`& "$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1" doctor`,
  'node ~/.wy-tools/wy-ops/current/lib/install.js doctor --todos',
  'powershell -File ~/.wy-tools/wy-ops/current/install.ps1 --help',
  'powershell -File ~/.wy-tools/wy-ops/current/install.ps1 doctor 2>&1 | tail -20',
  'cd ~/.wy-tools/wy-ops/current && powershell -File install.ps1 doctor',
  // pm 보고(진행현황 134줄): 문서에 덧붙이는 PowerShell here-string 본문에 설정 파일 이름이 있어도 대상(docs/…)만 본다
  `Add-Content -Encoding utf8 docs/진행현황.md @'${NL}- .claude/wy-ops.json·settings.local.json 정리 > 다음${NL}'@`,
  `Add-Content -Path docs/진행현황.md -Value @"${NL}- ~/.claude/wy-approvals/my-project/decisions 확인${NL}"@`,
  `@'${NL}- .claude/wy-ops.json 정리${NL}'@ | Add-Content docs/진행현황.md`,
  // 따옴표 문자열 내용도 데이터(대상만 본다)
  'Add-Content docs/진행현황.md "- .claude/wy-ops.json·settings.local.json 정리"',
  'Add-Content -Path docs/진행현황.md -Value "- ~/.claude/wy-approvals/my-project/decisions 확인"',
  // KI-02(2026-10-14): 설치본 doctor로 다른 프로젝트 점검, 임시 사본 폴더로 이동·설정 복사, 시험 스크립트를 cat으로 쓰고 실행
  'node ~/.wy-tools/wy-ops/current/lib/install.js doctor --project C:/projects/other',
  W`powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1" doctor --project C:\projects\other`,
  W`& "$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1" doctor --project=.`,
  W`$S="$env:TEMP\c1"; Set-Location $S; Get-ChildItem test,vscode/test -Filter *.test.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE) { throw $_.Name } }`,
  'cd $TMP/c1 && node test/a.test.js',
  'S=/tmp/c1; cp .claude/wy-ops.json $S/.claude/wy-ops.json',
  W`Copy-Item .claude/wy-ops.json $env:TEMP\c1\.claude\wy-ops.json`,
  W`$S="$env:TEMP\c1"; Copy-Item -Path .claude/wy-ops.json -Destination "$S\.claude\wy-ops.json" -Force`,
  'S=/tmp/c1; rm -rf $S; mkdir -p $S && git archive HEAD | tar -x -C $S && ls ~/.claude/wy-approvals/my-project/decisions && cat ~/.claude/wy-approvals/my-project/decisions/a.json',
  `mkdir -p /tmp/k && cat > /tmp/k/try.js <<'EOF'${NL}const c = ['cp .claude/wy-ops.json $S/x', 'rm ~/.claude/wy-approvals/a/decisions/x'];${NL}console.log(c.length);${NL}EOF${NL}node /tmp/k/try.js`,
  `node -e "const fs=require('fs');const d=require('os').homedir()+'/.claude/wy-approvals/my-project/requests/';fs.renameSync(d+'20261013-guard-rename.json.part',d+'20261013-guard-rename.json')"`,
  'Remove-Item ~/.claude/wy-approvals/my-project/requests/20261014-a.json',
  // KI-02 2차: Join-Path·mktemp로 만든 임시 사본 경로, 하드링크가 아닌 파일에 쓰기
  '$S = Join-Path $env:TEMP c1; Set-Location $S; node gen-agents.test.js',
  '$S = Join-Path $env:TEMP "c1"; Copy-Item .claude/wy-ops.json (Join-Path $S .claude/wy-ops.json)',
  "$S = Join-Path -Path $env:TEMP -ChildPath 'c1'; Remove-Item -Recurse -Force $S; New-Item -ItemType Directory $S",
  'S=$(mktemp -d); git archive HEAD | tar -x -C $S; cp .claude/wy-ops.json $S/.claude/wy-ops.json',
  'cat .claude/wy-ops.json > h3.txt',
  '$S = (Join-Path $env:TEMP c1); Copy-Item .claude/wy-ops.json $S/.claude/wy-ops.json',
  // KI-08: 설치본 경로 변수·읽기와 node 실행을 한 명령에
  W`$i = "$HOME\.wy-tools\wy-ops\current\install.ps1"; & $i doctor`,
  'cd /tmp/x && node a.js; ls ~/.wy-tools/wy-ops/current/vscode/hooks/',
  'node a.js && cat ~/.wy-tools/wy-ops/current/package.json',
  'node a.js; cat ~/.wy-tools/wy-ops/current/package.json | jq .version',
  `echo {} > ${fwd(tmpLinkCwd)}/src/b.log`,
  // KI-08 A1·A3: 블록 안 설치본 doctor, 블록 안 다른 파일 쓰기, 보호 경로가 아닌 식 인자
  'if (Test-Path ~/.wy-tools/wy-ops/current) { & ~/.wy-tools/wy-ops/current/install.ps1 doctor }',
  'Get-ChildItem src | ForEach-Object { Copy-Item $_.FullName /tmp/c1/ }',
  "Set-Content ('docs/' + 'a.md') 1",
  "Copy-Item x (Join-Path $dir 'out.txt')",
  "Get-Content ('~/.cl' + 'aude/wy-ops.json')",
  // D-35 실사용 오탐: 보호 이름은 다른 조각에서 읽기만 함, 임시 사본에서 시험 실행, 값 모르는 [ ]·*>, 출력 문자열 안 링크 글자, PowerShell 상수
  'node fp3.js; ls ~/.wy-tools/wy-ops/current/vscode/hooks/ 2>&1 | head -3; grep -n "wy-approval-guard" ~/.claude/settings.json | head',
  W`$d = (cygpath -w /tmp/tmp.abc 2>$null); if (-not $d) { $d = Join-Path $env:TEMP 'tmp.abc' }; Set-Location $d; $n=0; Get-ChildItem test,vscode/test -Filter *.test.js | ForEach-Object { node $_.FullName *> $null; if ($LASTEXITCODE) { throw $_.Name }; $n++ }; node gen-agents.test.js *> $null; "pass $n"`,
  'F="a.js b.js" && D=$(mktemp -d) && git archive HEAD | tar -x -C "$D" && for f in $F; do cp "$f" "$D/$f"; done && cd "$D" && for f in test/*.test.js; do node "$f" >/dev/null || echo "FAIL $f"; done; cd /; rm -rf "$D"',
  W`$base="$env:TEMP\s2"; foreach($w in 'w1','w2'){ Copy-Item C:\projects\other\package.json "$base\$w\" }; foreach($w in 'w1','w2'){ $t=Measure-Command { npm ci --prefix "$base\$w" *> "$base\$w.log" }; "$w secs=$([int]$t.TotalSeconds)" }`,
  W`$t=Measure-Command { cmd /c mklink /J C:\tmp\w2\nm C:\tmp\w1\nm | Out-Null }; "junction secs=$([math]::Round($t.TotalSeconds,2))"; Set-Location C:\tmp\w2; node -e "console.log(require.resolve('vite'))"`,
  W`Set-Location C:\projects\other; cmd /c dir /a /b .claude\worktrees\t2\.claude; $a=Get-FileHash .claude\settings.local.json; $b=Get-FileHash .claude\worktrees\t2\.claude\settings.local.json -ErrorAction SilentlyContinue; "same=$($a.Hash -eq $b.Hash)"`,
  "Select-String -Path .claude/wy-ops.json -Pattern 'dev3' ; Test-Path .claude/agents/X-dev3.md; Remove-Item .claude/ops/roles/X-dev3.md -Confirm:$false; git diff --stat -- .claude/ops/roles",
  // 보호 이름을 읽기만 하는 조각 옆의 스크립트 실행
  'node a.test.js; cat .claude/wy-ops.json | jq .verify',
  'node a.js | cat .claude/wy-ops.json',
  // 다른 조각의 문자열 안에 같은 글자가 있어도 그 조각의 일로 치지 않음, 펼칠 수 없는 와일드카드를 읽기만
  'echo ".claude/wy-ops.json node w.js"; node w.js',
  "bash -c 'cat ~/.cl?ude/wy-a*/my-project/decisions/a.json'",
];
// 저장소 링크 쓰기: 저장소가 임시 폴더 밖이면 거부, 저장소 자체가 임시 사본(git archive 등)이면 임시 사본 예외로 통과
const repoRel = path.relative(fs.realpathSync.native(os.tmpdir()), fs.realpathSync.native(path.resolve(__dirname, '..', '..')));
const repoInTemp = !(repoRel.startsWith('..') || path.isAbsolute(repoRel));
(repoInTemp ? allow : deny).push(`cp e.json ${fwd(tmpLink)}/.claude/wy-ops.json`);
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
// KI-08 A1: 너무 깊게 묶인 명령은 오류(훅은 종료 코드 2로 막음), 커밋 메시지 here-doc 본문 줄은 잠금 대상이 아니다
let deep = false;
try { ev('('.repeat(12) + 'git push' + ')'.repeat(12)); } catch { deep = true; }
ok(deep, 'should throw on deep nesting');
const msg = ev(`echo "$(cat <<'EOF'${NL}fix: 안내${NL}git push 전에 확인${NL}EOF${NL})"`);
ok(msg === null, 'heredoc message line guarded: ' + JSON.stringify(msg));

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
for (const l of [tmpLink, tmpLinkCwd, claudeLink, brokenLink, decLink]) fs.unlinkSync(l);
fs.rmSync(proj, { recursive: true, force: true });
fs.rmSync(process.env.WY_APPROVALS_DIR, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : `guard 검사 통과 (거부 ${deny.length}, 통과 ${allow.length})`);
process.exit(fail ? 1 : 0);
