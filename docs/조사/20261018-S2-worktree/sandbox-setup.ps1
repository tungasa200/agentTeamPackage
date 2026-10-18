# S2 버릴 저장소 준비(사용자가 일반 PowerShell 창에서 한 번 실행). Claude 세션 밖에서 돌려야 한다:
# 역할 세션은 승인 가드 때문에 git commit·merge를 어느 저장소에서도 못 하고, 설치본 install.ps1 init도 못 부른다.
# 하는 일: C:\projects\wt-sandbox(octocat/Hello-World 복제, origin 제거됨)에 wy-ops init → 생성 파일 커밋 →
#          충돌 시험용 가지 wt-a·wt-b(같은 줄을 다르게 고침) → master에 병합 시험(두 번째는 충돌 → abort) → 기록을 s2-log.txt에
# 폴더 신뢰: 이 스크립트를 돌리기 전에 C:\projects\wt-sandbox에서 claude를 한 번 실행해 trust에 Yes → /exit
$ErrorActionPreference = 'Continue'
$S = 'C:\projects\wt-sandbox'
$log = Join-Path $S 's2-log.txt'
function Log($m) { $m | Tee-Object -FilePath $log -Append }
Set-Location $S
Log "== init $(Get-Date -Format s)"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1" init --project $S --name wt-sandbox --prefix WT- --yes --skip-extras --skip-install 2>&1 | ForEach-Object { Log "$_" }
git add -A 2>&1 | ForEach-Object { Log "$_" }
git commit -q -m "sandbox: wy-ops init" 2>&1 | ForEach-Object { Log "$_" }
Log "== branches"
git worktree add -b wt-a ..\wt-sandbox-a master 2>&1 | ForEach-Object { Log "$_" }
git worktree add -b wt-b ..\wt-sandbox-b master 2>&1 | ForEach-Object { Log "$_" }
'Hello World from A' | Out-File -Encoding ascii ..\wt-sandbox-a\README
'Hello World from B' | Out-File -Encoding ascii ..\wt-sandbox-b\README
git -C ..\wt-sandbox-a commit -q -am "A: README" 2>&1 | ForEach-Object { Log "$_" }
git -C ..\wt-sandbox-b commit -q -am "B: README" 2>&1 | ForEach-Object { Log "$_" }
Log "== merge wt-a (no-ff)"
git merge --no-ff -m "merge wt-a" wt-a 2>&1 | ForEach-Object { Log "$_" }
Log "== merge wt-b (expect conflict)"
git merge --no-ff -m "merge wt-b" wt-b 2>&1 | ForEach-Object { Log "$_" }
git status --short 2>&1 | ForEach-Object { Log "$_" }
git merge --abort 2>&1 | ForEach-Object { Log "$_" }
Log "== done $(Get-Date -Format s)"
git log --oneline --graph --all 2>&1 | ForEach-Object { Log "$_" }
git worktree list 2>&1 | ForEach-Object { Log "$_" }
