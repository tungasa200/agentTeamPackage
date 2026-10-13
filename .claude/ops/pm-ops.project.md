## 프로젝트 부록 (agentTeamPackage, 도구 wy-ops)

위 절차에 더해 이 프로젝트에서만 지키는 것. 위와 다르면 이 부록을 따른다. 고친 뒤에는 `install.ps1 gen`으로 스킬을 다시 만든다(update는 사람이 고친 이 파일을 덮지 않는다).

### 0. 늘 지키는 것
- **사용자에게 하는 말, 승인 센터 카드, 다른 세션에 보내는 메시지는 모두 한국어로 쓴다.** 다른 세션이 영어로 보고해도 pm은 한국어로 정리한다(erp에서 사용자가 명시한 규칙, 여기도 같음).
- 역할 세션: OPS-commit·OPS-dev1(`vscode/`, 공용 파일)·OPS-dev2(`lib/`·`templates/`·`install.ps1`·`gen-*.js`·`scripts/`)·OPS-review(코드 수정 안 함). 이름이 역할과 다른 세션에는 짐작해서 보내지 않는다.
- **중복 pm 판단은 `ListAgents`로 하지 않는다.** pm 교체 직후 멈춘 이전 OPS-pm이 몇 분 동안 `ListAgents`에 busy로 남는다(KI-03, 2026-10-13 실측). `session.ps1 list` 또는 `claude agents --json --all`에서 pid가 있는 OPS-pm이 하나면 경고하지 않는다.
- 이 저장소는 도구 원본이고, erp-project는 그 설치본(`~/.wy-tools/wy-ops/current`)을 쓰는 고객이다. 배포·rollback·승인 가드 훅 변경은 erp 세션에도 바로 영향을 준다(DEP-01·DEP-03).

### 1. 작업 지시
- 작업 ID: 요구사항정의서 ID(SEP·MP·DEP·INS 등), 진행 ID(ENH-nn·HC-nn·KI-nn), 결정 D-nn. 지시에 이 중 근거 ID를 넣는다.
- 경계: `templates/`를 고치면 생성물(`.claude/agents`·`.claude/skills/pm-ops`)은 배포 뒤 `install.ps1 gen`으로만 바뀐다. 두 dev가 같은 파일을 만지지 않게 한다(공용 파일은 OPS-dev1).

### 2. 보고 처리
- [완료] 확인: `git log --oneline origin/main`, `git status --short`. CI가 없으므로 검증은 세션 보고의 시험 결과와 OPS-commit 사본 시험이다.
- 결정 기록과 문서(`docs/`)는 OPS-pm이 직접 쓴다(planner 없음). 요구사항정의서·작업계획서 변경은 `docs/개정대기.md`에 쌓고 단계 끝에 일괄 개정한다(DOC-02).
- [결함](OPS-review): 재현·기대·실제·담당을 그대로 넘긴다. 배포를 막는지 pm이 정해 OPS-review에 회신한다.

### 3. 메모리
- 무거운 작업: 전체 시험(test·vscode/test *.test.js + gen-agents.test.js), OPS-commit 사본 시험, doctor 두 저장소. 서버·브라우저는 거의 안 쓴다.

### 4. 커밋 묶음
- 제품 파일(lib·vscode·templates·install.ps1·package.json)은 배포 전에 모두 커밋되어 있어야 한다. deploy는 HEAD를 복사한다.
- 문서 커밋은 다음 코드 묶음과 함께 요청해 카드 수를 줄인다. 푸시는 배포 묶음 때.

### 6-1. 세션
- 승인 카드(choice·todo 포함)는 Write 도구로 쓰고, 쓴 직후 `./vscode/approvalStore.js`의 `readRequest(파일, id)`로 `broken`이 없는지 확인한 뒤 알린다. 셸로 승인 폴더를 다루면 승인 가드가 오탐한다(KI-02).
- 멈춘 세션을 `session.ps1 start <역할> "지시"`로 다시 띄우면 새 id 복사본이 뜨고 옛 id는 blocked로 남는다. 기능 문제는 없다.
- 스크립트와 안내 명령은 `claude.cmd`로 부른다(기본 실행 정책에서 claude.ps1이 막힘).

### 7. 단계 마무리
- 배포 관문(S1 이후 매 배포): 전체 시험 → doctor 두 저장소 → OPS-review 문서 대조 → 배포 승인 카드 → `install.ps1 deploy` → 승인 가드 probe(DEP-03) → 두 저장소 `install.ps1 gen`(필요하면 `setup`) → 진행현황 갱신. 절차서 원본은 OPS-review 보고(2026-10-13).
- deploy·rollback·setup·gen은 설치본(`~/.wy-tools`)과 settings.local.json에 쓰므로 승인 가드가 역할 세션에서 막는다(2026-10-13 OPS-dev2가 deploy에서 막힘). 처음부터 사용자가 터미널에서 실행하는 할 일 카드(명령 순서를 steps에)로 올리고, 세션은 결과를 읽기만으로 확인한다. 세션이 우회하지 않는다.
