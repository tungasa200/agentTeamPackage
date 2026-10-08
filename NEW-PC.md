# 새 PC 체크리스트

`install.ps1 setup`·`global`이 끝에 이 파일을 그대로 보여 줍니다. 설치 명령이 대신할 수 없는 손일만 적었습니다. 자동으로 확인할 수 있는 것은 `install.ps1 doctor`가 보고, 승인 센터가 뜬 뒤에는 남은 일이 할 일 카드로 올라옵니다.

## 1. 설치 전에

- Windows 10 이상, Windows PowerShell 5.1, winget(앱 설치 관리자).
- Node.js LTS·Git·GitHub CLI·VS Code·Claude Code는 `install.ps1`이 확인하고, 없으면 확인받은 뒤 설치합니다. 설치 직후 명령을 못 찾으면 새 터미널을 열어 다시 실행합니다.
- VS Code의 `code` 명령: 없으면 명령 팔레트 → `Shell Command: Install 'code' command in PATH`.
- Claude Code 폴더 신뢰: 운영 도구를 쓸 프로젝트 폴더의 터미널에서 `claude`를 한 번 실행해 'Do you trust the files in this folder?'에 Yes → `/exit`. VS Code의 '작성자 신뢰'와는 따로이고, 이것이 없으면 백그라운드 역할 세션이 'Workspace not trusted'로 시작되지 않습니다.

## 2. 로그인

- [ ] Claude Code: `claude` 실행 후 `/login`
- [ ] GitHub CLI: `gh auth login` 뒤 `gh auth status`가 Logged in이면 됩니다(커밋 역할이 PR·CI 확인에 씁니다). doctor가 확인합니다.
- [ ] 외부 콘솔(배포·호스팅 등): 브라우저에서 사람이 로그인합니다. 2단계 인증·Google 로그인은 자동화 브라우저에서 막히므로 사람이 합니다.

## 3. 원래 PC에서 옮겨 오기

git으로 옮기는 것(코드·문서·결정)은 커밋·푸시로 넘깁니다. git 밖의 개인 상태는 이전 묶음으로 옮깁니다.

원래 PC에서:
- [ ] 승인 센터의 대기 카드를 모두 처리합니다.
- [ ] 역할 세션이 진행 중인 것을 저장하게 하고(pm이 '세션 교체 준비'를 지시) 작업 경계에서 멈춥니다.
- [ ] 커밋 안 된 변경·푸시 안 된 커밋을 정리합니다. `export`가 남은 것을 경고합니다.
- [ ] 프로젝트 폴더에서 `install.ps1 export --out <zip>`. 묶음은 그 시점의 사본입니다(동기화 아님).

새 PC에서:
- [ ] 이 저장소를 clone하고 `install.ps1 restore <zip>`. 설치본·확장 → 프로젝트 clone(묶음의 원격·브랜치) → 묶음 들여오기 → 프로젝트 setup·doctor 순서로 진행하고, 끝에 남은 할 일을 출력합니다. Claude Code 창·세션을 모두 끈 상태에서 실행합니다.
- [ ] 묶음 파일은 개인 USB나 드라이브로만 옮기고, 옮긴 뒤 지웁니다.

묶음에 들어가는 것: 프로젝트 메모리, 승인 이력('사용됨'으로 표시되어 다시 승인으로 쓰이지 않음), 인수인계 파일, `settings.local.json`, 사용자 전역 설정(`~/.claude`의 CLAUDE.md·skills·agents·hooks·settings, `~/.claude.json`의 MCP 서버). 토큰·키·env 값은 자리표시로 바뀌어 들어가고, `restore`가 다시 입력할 항목을 알려 줍니다.

묶음에 들어가지 않는 것: 로그인 정보, 세션 트랜스크립트, 캐시·로그, 비밀값 폴더.

## 4. 손으로 옮기는 것

- [ ] 비밀값 폴더: 프로젝트 `.claude/wy-ops.json`의 `secretsDir`를 정했을 때만. 저장소 밖에 있습니다. 암호화된 USB나 비밀번호 관리자처럼 안전한 방법으로 직접 복사하고, 메신저·메일·클라우드 공유로 보내지 않습니다. doctor는 폴더와 키 이름(`secretsKeys`)이 있는지만 보고 값은 읽지 않습니다.
- [ ] MCP 서버 토큰: `restore`가 출력한 '다시 입력' 항목을 채웁니다.
- [ ] VS Code 사용자 설정: Settings Sync 등 평소 쓰는 방법으로.

## 5. 역할별 외부 준비

그 역할 세션을 실행할 PC에만 하면 됩니다.

- [ ] browser 역할: 전용 Chrome 프로필을 만들고, 원격 디버깅 포트(예: 9222)로 실행하는 바로 가기를 만듭니다. 그 프로필에서 외부 콘솔에 로그인해 둡니다.
- [ ] qa·design 역할: agent-browser는 설치 명령이 함께 설치합니다. 브라우저 자동화는 자기 세션 이름으로 따로 실행하고 browser 역할의 전용 프로필에는 붙지 않습니다.
- [ ] 개발 역할(백엔드·프론트 등): 프로젝트 README의 개발 환경(JDK, Docker 등)을 따릅니다. 스택 개발 도구는 `init`·`doctor`가 확인하고 설치 방법을 알려 줍니다.

## 6. 함께 까는 도구

`setup`이 함께 까는 도구(agent-browser, 전역 스킬, MCP, 플러그인)를 설치합니다. 플러그인 마켓플레이스는 버전 고정을 지원하지 않아 늘 최신이 설치됩니다. `plugins.json`의 version은 최소 버전이고, doctor는 그보다 낮을 때만 주의를 띄웁니다. 쓰지 않을 선택 항목은 `.claude/wy-ops.json`의 `extras.off`에 id를 적으면 doctor가 '꺼짐'으로 보고 설치하지 않습니다.
