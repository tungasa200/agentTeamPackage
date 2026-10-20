# WY Ops

여러 Claude Code 세션이 역할(pm·커밋·백엔드·프론트·QA …)을 나눠 한 저장소에서 함께 일할 때 쓰는 운영 도구입니다. Windows 전용입니다.

- **승인 센터**(VS Code 확장): 세션이 올린 권한 요청·결정 요청·할 일·git 승인을 한곳에서 처리합니다.
- **세션 현황·활동 탭**: 역할 세션의 상태와 세션끼리 주고받은 메시지를 봅니다. 세션 표 바로 위 pm 줄에서 백그라운드 pm을 시작·붙기·교체·멈춤합니다(0.10.0).
- **훅 6종**: 커밋은 커밋 역할만 승인을 받은 뒤 실행하게 하고(승인 가드), 백그라운드 세션의 권한 요청을 카드로 바꿉니다(권한 요청). 종료된 세션에 보내는 메시지를 막고(메시지 가드), 세션의 역할을 기록하고(세션 시작), 대화가 길어지면 세션 교체를 알리고(컨텍스트 크기), 카드가 처리되면 올린 세션을 깨웁니다(결정 깨우기). 각각 `vscode/hooks/`의 `wy-approval-guard`·`wy-permission`·`wy-message-guard`·`wy-session-start`·`wy-context-size`·`wy-decision-wake`입니다.
- **역할 생성**: 역할 파일(`.claude/agents/<역할>.md`), pm 운영 스킬(`pm-ops`), 세션 실행·세션 교체 스크립트(`session.ps1`)를 만듭니다.
- **역할 worktree**(기본 켬): pm·커밋을 뺀 역할 세션이 각자 `.claude/worktrees/<역할>`(가지 `wt/<역할>`)에서 일해 서로의 미커밋 파일이 섞이지 않습니다. 커밋 역할이 승인 카드를 거쳐 기준 가지에 병합합니다. 끄려면 `init`·`quickstart`에 `--no-worktree`, 또는 `wy-ops.json`의 `worktree.enabled`를 `false`로. 자세한 것은 [MANUAL.md](MANUAL.md) 2-6.
- **점검·이전**: `doctor`로 설치 상태를 확인하고, `export`·`restore`로 개인 상태를 새 PC로 옮깁니다.
- **원격(선택)**: 한 PC를 호스트로 두고 다른 PC(노트북)에서 VS Code 원격 창으로 이어 씁니다. `host`·`connect`로 준비하고, 접속 PC의 제어 창에서 호스트 깨우기(집 밖에서는 폰 중계)·재우기·재부팅·종료를 합니다. pm 붙기는 원격 창 세션 현황 pm 줄에서 합니다. 자세한 것은 [MANUAL.md](MANUAL.md) 3-5.

사용법(팀이 일하는 흐름·설치·매일 쓰기·역할 바꾸기·패키지 고치기와 배포)은 [MANUAL.md](MANUAL.md), 새 PC 체크리스트는 [NEW-PC.md](NEW-PC.md), 카드 요청 파일 형식은 [vscode/README.md](vscode/README.md)에 있습니다.

## 요구 환경

- Windows 10 이상, Windows PowerShell 5.1, winget(앱 설치 관리자)
- `install.ps1`이 시작할 때 Node.js LTS(18 이상)·Git·GitHub CLI·VS Code·Claude Code가 있는지 확인합니다. 없는 것은 목록을 보여 주고 한 번 확인받은 뒤 winget으로 설치합니다(Claude Code는 npm). `--yes`는 확인 없이 설치, `--skip-install`은 확인만 합니다.

## WY Ops 설치하기

1. Git을 설치합니다. git-scm.com/download/win에서 받아 실행하고, 묻는 화면은 모두 그대로 두고 [Next] → [Install]을 누릅니다. 이미 있으면 건너뜁니다.
2. PowerShell을 엽니다. 시작 메뉴에서 'PowerShell'을 찾아 엽니다. 방금 Git을 설치했다면 새로 엽니다.
3. 아래 한 줄을 붙여 넣고 Enter를 누릅니다. GitHub 로그인 창이 뜨면 로그인합니다.
   ```powershell
   git clone <이 저장소 주소> C:\tools\wy-ops
   ```
4. `C:\tools\wy-ops` 폴더의 `setup.cmd`를 더블클릭합니다. 이후는 설치 창이 안내합니다.

설치 창(마법사, 0.9.0)은 아래 `quickstart`를 창으로 보여 주는 것입니다: 시작 → 프로젝트 폴더 → 설치 → Claude 로그인 → GitHub 로그인(나중에 해도 됨) → 폴더 사용 허락 → 마침. 자세한 것은 [MANUAL.md](MANUAL.md) 3-0.

## 빠른 시작(터미널)

1. 이 저장소를 `C:\tools\wy-ops`에 받습니다(git이 없으면 먼저 `winget install -e --id Git.Git`, 새 PowerShell 창을 엽니다).
   ```powershell
   git clone <이 저장소 주소> C:\tools\wy-ops
   ```
2. 아래 한 줄을 PowerShell에 붙여 넣습니다. 이것으로 끝입니다.
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\tools\wy-ops\install.ps1 quickstart
   ```
   - 묻는 것은 **프로젝트 폴더**와 **이름** 둘뿐입니다(Enter = 보이는 기본값). 경로는 따옴표째 붙여 넣어도 되고 `~`도 됩니다. 없는 폴더는 만들고, git 저장소가 아니면 `git init`을 합니다.
   - 필요한 프로그램(Node.js·Git·GitHub CLI·VS Code·Claude Code)이 없으면 설치를 한 번 묻습니다.
   - 나머지는 기본값입니다: 스택은 루트와 바로 아래 폴더의 파일로 폴더마다 알아냄(미리 보기 `install.ps1 detect`, 빈 폴더에 설치했으면 코드가 생긴 뒤 `install.ps1 detect --apply`), 역할은 아래 기본 구성, 역할 접두사는 이름 앞 두 글자(`my-app` → `MY-`), 역할 worktree 켬(끄려면 `--no-worktree`).
   - `CLAUDE.md`가 없으면 운영 도구 절을 넣어 만들고, 있으면 고치지 않고 붙일 내용을 보여 줍니다.
   - 로그인(Claude Code·GitHub)과 폴더 신뢰는 대신할 수 없어서, 그 자리에서 할 일을 한 줄로 알리고 Enter를 누르면 같은 창에서 엽니다. 이미 된 것은 건너뜁니다.
   - 끝에 점검(doctor) 결과를 "됐음 / 이것만 남음"으로 요약하고 VS Code로 프로젝트를 엽니다. 왼쪽 활동 막대에 **WY Ops** 아이콘이 보이면 됩니다.

역할 수·담당 영역을 직접 고르거나 스택을 덮어쓰고 싶으면 `quickstart` 대신 `global` → `init`을 씁니다([MANUAL.md](MANUAL.md) 3장 '직접 고르고 싶을 때').

같은 프로젝트를 다른 PC에서 이어 갈 때는 프로젝트를 clone한 뒤 그 폴더에서 `install.ps1 setup`을 실행합니다. 원래 PC의 개인 상태(메모리·승인 이력·전역 설정)까지 옮기려면 `export` → 새 PC에서 `restore <zip>`을 씁니다([NEW-PC.md](NEW-PC.md)).

## 역할 기본 구성

`init`은 아래 역할을 기본으로 만듭니다. 수(0~4)와 담당 영역은 바꿀 수 있습니다(`--roles`, `--count backend=2,frontend=1`, `--area "AB-backend1=server/;AB-backend2=tools/"`). 같은 역할이 2개 이상이면 이름에 번호가 붙고(`AB-backend1`, `AB-backend2`), 첫 번째가 공용 파일을 맡습니다.

| 역할 | 하는 일 | 기본 수 |
|---|---|---|
| pm | 개발 총괄: 작업 지시, 보고 취합, 중요 결정을 사용자에게 올림 | 1(고정) |
| commit | 커밋·버전관리 전담 | 1(고정) |
| planner | 기획·아키텍처 결정, 요구사항·결정기록 | 1 |
| backend | 서버·공통 모듈·빌드 | 2 |
| frontend | 화면·공용 컴포넌트·API 연결 | 2 |
| qa | 사용성·기능 테스트 | 1 |
| design | 화면 설계·목업, 구현 화면 점검 | 1 |
| browser | 외부 서비스 콘솔 작업(코드는 수정하지 않음) | 1 |

스택: `node`, `python`, `java-gradle`, `java-maven`, `csharp`, `cpp`, `custom`. 고르지 않고 루트와 바로 아래 폴더의 표지 파일(`package.json`, `build.gradle`·`gradlew`, `pom.xml`, `pyproject.toml`·`requirements.txt`, `*.sln`·`*.csproj`, `CMakeLists.txt` 등)로 폴더마다 알아내, 검증 명령(`wy-ops.json`의 `verify`)과 개발 도구 확인 목록을 정합니다. 루트가 Gradle·Maven·.NET 솔루션·CMake면 루트와 같은 스택인 하위 폴더는 모듈로 보고 빼고, Node·Python 하위 폴더는 폴더별 명령을 잡습니다. node 실행기는 잠금 파일로 고릅니다(npm·pnpm·yarn·bun). 틀리면 `.claude/wy-ops.json`의 `verify`를 고치고 `install.ps1 gen`. `init --stack <id>`는 덮어쓰기용(알아내지 않고 그 템플릿을 씀)입니다. 루트에 그 스택의 파일(`package.json`·`build.gradle` 등)이 있으면 폴더 내용으로 다듬습니다. node는 `scripts`에 있는 명령만 쓰고, `gradlew`·`mvnw`가 없으면 `gradle`·`mvn`을 씁니다. 빈 폴더면 템플릿 값을 그대로 씁니다. 개발 도구가 없으면 winget 설치를 제안합니다.

`init`이 만드는 CLAUDE.md 절에는 '작업 원칙'(가정 명시, 단순함 우선, 정밀한 수정, 완료 전 검증, 하나 가르치기)이 들어갑니다. 빼려면 `--no-principles`.

## 함께 까는 도구

설치 때 아래 도구를 함께 설치합니다. 고른 역할에 꼭 필요한 것(frontend·design → impeccable, qa·design·browser → agent-browser)은 끌 수 없고, 나머지는 끌 수 있습니다. 끈 항목은 `.claude/wy-ops.json`의 `extras.off`에 남고, doctor는 이를 '꺼짐'으로 표시합니다(실패 아님).

플러그인 claude-mem·prompts.chat은 선택이고 기본은 꺼짐입니다. `init`이 프로젝트의 `.claude/settings.json` `enabledPlugins`에 둘을 `false`로 넣어 그 프로젝트에서 끕니다. 예전에 ecc를 깐 PC를 위해 `ecc@ecc`도 `false`로 넣어 끕니다. 세션 저장·재개는 wy-ops가 만드는 스킬 `/wy-save-session`·`/wy-resume-session`이 맡습니다.

| 항목 | 설치 방법 |
|---|---|
| agent-browser, agent-browser MCP | npm 전역 설치, `agent-browser install`, 사용자 범위 MCP 등록 |
| 전역 스킬 agent-reach, find-skills, graphify | 각 출처의 설치 명령(pipx·npx) |
| 플러그인 impeccable, claude-mem·prompts.chat(선택·기본 꺼짐) | `claude plugin install` |

Python·pipx는 pipx로 까는 항목이 켜져 있을 때만 설치합니다. 이 저장소에는 다른 사람의 코드를 두지 않고 설치 명령만 둡니다(`extras.json`, `plugins.json`).

## 명령

`install.ps1 <명령>`. 설치 후에는 `"$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1"`로 부릅니다.

| 명령 | 하는 일 |
|---|---|
| `quickstart` | 한 줄 설치: `global` + 폴더·git 준비 + `init`(기본값) + CLAUDE.md + 로그인·신뢰 안내 + 점검 요약. 설치본이 있으면 다시 배포하지 않고, clone이 더 새로우면 `deploy` 안내만 함 |
| `global` | 설치본·VS Code 확장·함께 까는 도구. 어느 프로젝트도 건드리지 않음 |
| `setup` | `global` + 이 프로젝트의 훅 설정(`settings.local.json`, 차이를 보여 주고 확인) + doctor |
| `init` | 새 프로젝트에 설정·역할 파일·스킬 만들기 |
| `doctor` | 설치 상태 점검(읽기만). FAIL 줄의 '고치기'를 따름 |
| `trust` | 폴더 사용 허락을 `~/.claude.json`에 기록(설치 마법사가 씀, `--check`는 확인만) |
| `update` | 이 저장소를 pull하고 새 버전 설치, 생성 파일 다시 만들기(사람이 고친 파일은 덮지 않고 차이만), `.claude/settings.json` 표준의 빈 키만 채우기(있는 값은 그대로, 다르면 '다름'으로 알림) |
| `gen` | `.claude/ops`의 역할 원본을 고친 뒤 역할 파일·스킬 다시 만들기 |
| `deploy` / `rollback` | 설치본만 갱신 / 이전 버전으로 |
| `export` / `import` / `restore` | 개인 이전 묶음 만들기 / 들여오기 / 새 PC 한 번에 복원 |
| `host` | 이 PC를 원격 호스트로(관리자 PowerShell, MANUAL 3-5). `--dry-run`은 목록만. `--add-key`는 접속 PC 공개키 등록 |
| `connect` | 접속 PC 준비: 키·ssh 별칭·Remote-SSH·바로가기·호스트 제어 창(MANUAL 3-5) |

## 개발

고치기 → 시험 → 커밋 → deploy → 프로젝트 갱신 순서는 [MANUAL.md](MANUAL.md) 10장에 있습니다.

- 작업 사본을 바로 쓰려면 `install.ps1 deploy --dev`(설치본 `current`가 이 폴더를 가리킵니다. doctor가 '개발 연결 중'으로 알립니다). 풀려면 `install.ps1 deploy`.
- 시험: 저장소 루트에서 `node test/<이름>.test.js`, `node vscode/test/<이름>.test.js`. npm 의존성은 없습니다. 시험은 임시 폴더·가짜 명령으로 돌고 실제 홈 폴더와 설치본은 건드리지 않습니다.

- 새 PC로 옮기기는 [NEW-PC.md](NEW-PC.md)를 따릅니다(예: `powershell -ExecutionPolicy Bypass -File <설치 폴더>\install.ps1 restore <zip> --project <프로젝트를 clone한 폴더>`).
- 버전: 0.x는 개발 중, 첫 공개 판이 1.0.0입니다. 프로젝트는 `.claude/wy-ops.json`의 `wyOpsVersion`으로 쓰는 버전을 적고, doctor가 설치본과 비교합니다.
- VS Code 확장 id(`wy-ops.wy-ops`)는 바꾸지 않습니다. 확장은 설치본 `current`를 읽는 얇은 껍데기라 버전을 바꿀 때 다시 설치하지 않아도 됩니다.
