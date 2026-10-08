# WY Ops

여러 Claude Code 세션이 역할(pm·커밋·백엔드·프론트·QA …)을 나눠 한 저장소에서 함께 일할 때 쓰는 운영 도구입니다. Windows 전용입니다.

- **승인 센터**(VS Code 확장): 세션이 올린 권한 요청·결정 요청·할 일·git 승인을 한곳에서 처리합니다.
- **세션 현황·활동 탭**: 역할 세션의 상태와 세션끼리 주고받은 메시지를 봅니다.
- **훅 5종**: 커밋은 커밋 역할만 승인을 받은 뒤 실행하게 하고, 백그라운드 세션의 권한 요청을 카드로 바꿉니다.
- **역할 생성**: 역할 파일(`.claude/agents/<역할>.md`), pm 운영 스킬(`pm-ops`), 세션 실행·세션 교체 스크립트(`session.ps1`)를 만듭니다.
- **점검·이전**: `doctor`로 설치 상태를 확인하고, `export`·`restore`로 개인 상태를 새 PC로 옮깁니다.

사용법은 [MANUAL.md](MANUAL.md), 새 PC 체크리스트는 [NEW-PC.md](NEW-PC.md), 카드 요청 파일 형식은 [vscode/README.md](vscode/README.md)에 있습니다.

## 요구 환경

- Windows 10 이상, Windows PowerShell 5.1, winget(앱 설치 관리자)
- `install.ps1`이 시작할 때 Node.js LTS(18 이상)·Git·GitHub CLI·VS Code·Claude Code가 있는지 확인합니다. 없는 것은 목록을 보여 주고 한 번 확인받은 뒤 winget으로 설치합니다(Claude Code는 npm). `--yes`는 확인 없이 설치, `--skip-install`은 확인만 합니다.

## 빠른 시작

1. 이 저장소를 받습니다(경로에 공백·한글이 없는 곳 권장).
   ```powershell
   git clone <이 저장소 주소> C:\tools\wy-ops
   ```
2. 이 PC에 설치합니다(한 번만). 설치본은 `%USERPROFILE%\.wy-tools\wy-ops\`에 버전별로 들어가고 `current`가 지금 버전을 가리킵니다.
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\tools\wy-ops\install.ps1 global
   ```
3. 운영 도구를 붙일 프로젝트 폴더에서(먼저 `git init`):
   ```powershell
   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1" init --name <프로젝트 이름> --prefix <역할 접두사, 예: AB->
   ```
   스택(`--stack`)·역할 수·담당 영역을 묻습니다. 출력 끝의 **CLAUDE.md에 넣을 절**을 프로젝트 `CLAUDE.md`에 붙입니다.
4. 그 폴더 터미널에서 `claude`를 한 번 실행해 폴더 신뢰에 Yes → `/exit`. VS Code로 폴더를 열고 `Developer: Reload Window`.
5. 왼쪽 활동 막대에 **WY Ops** 아이콘이 보이면 됩니다. 확인은 `install.ps1 doctor`.

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

스택: `node`, `python`, `java-gradle`, `csharp`, `cpp`, `custom`. 스택마다 빌드·테스트 명령과 개발 도구 확인 목록이 정해져 있습니다. 개발 도구가 없으면 winget 설치를 제안합니다.

`init`이 만드는 CLAUDE.md 절에는 '작업 원칙'(가정 명시, 단순함 우선, 정밀한 수정, 완료 전 검증, 하나 가르치기)이 들어갑니다. 빼려면 `--no-principles`.

## 함께 까는 도구

설치 때 아래 도구를 함께 설치합니다. 고른 역할에 꼭 필요한 것(frontend·design → impeccable, qa·design·browser → agent-browser, 세션 교체 → ecc)은 끌 수 없고, 나머지는 끌 수 있습니다. 끈 항목은 `.claude/wy-ops.json`의 `extras.off`에 남고, doctor는 이를 '꺼짐'으로 표시합니다(실패 아님).

| 항목 | 설치 방법 |
|---|---|
| agent-browser, agent-browser MCP | npm 전역 설치, `agent-browser install`, 사용자 범위 MCP 등록 |
| 전역 스킬 agent-reach, find-skills, graphify | 각 출처의 설치 명령(pipx·npx) |
| headroom MCP | pipx |
| 플러그인 ecc, impeccable, claude-mem, prompts.chat | `claude plugin install` |

Python·pipx는 pipx로 까는 항목이 켜져 있을 때만 설치합니다. 이 저장소에는 다른 사람의 코드를 두지 않고 설치 명령만 둡니다(`extras.json`, `plugins.json`).

## 명령

`install.ps1 <명령>`. 설치 후에는 `"$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1"`로 부릅니다.

| 명령 | 하는 일 |
|---|---|
| `global` | 설치본·VS Code 확장·함께 까는 도구. 어느 프로젝트도 건드리지 않음 |
| `setup` | `global` + 이 프로젝트의 훅 설정(`settings.local.json`, 차이를 보여 주고 확인) + doctor |
| `init` | 새 프로젝트에 설정·역할 파일·스킬 만들기 |
| `doctor` | 설치 상태 점검(읽기만). FAIL 줄의 '고치기'를 따름 |
| `update` | 이 저장소를 pull하고 새 버전 설치, 생성 파일 다시 만들기(사람이 고친 파일은 덮지 않고 차이만) |
| `gen` | `.claude/ops`의 역할 원본을 고친 뒤 역할 파일·스킬 다시 만들기 |
| `deploy` / `rollback` | 설치본만 갱신 / 이전 버전으로 |
| `export` / `import` / `restore` | 개인 이전 묶음 만들기 / 들여오기 / 새 PC 한 번에 복원 |

## 개발

- 작업 사본을 바로 쓰려면 `install.ps1 deploy --dev`(설치본 `current`가 이 폴더를 가리킵니다. doctor가 '개발 연결 중'으로 알립니다). 풀려면 `install.ps1 deploy`.
- 시험: 저장소 루트에서 `node test/<이름>.test.js`, `node vscode/test/<이름>.test.js`. npm 의존성은 없습니다. 시험은 임시 폴더·가짜 명령으로 돌고 실제 홈 폴더와 설치본은 건드리지 않습니다.
- 버전: 0.x는 개발 중, 첫 공개 판이 1.0.0입니다. 프로젝트는 `.claude/wy-ops.json`의 `wyOpsVersion`으로 쓰는 버전을 적고, doctor가 설치본과 비교합니다.
- VS Code 확장 id(`wy-ops.wy-ops`)는 바꾸지 않습니다. 확장은 설치본 `current`를 읽는 얇은 껍데기라 버전을 바꿀 때 다시 설치하지 않아도 됩니다.
