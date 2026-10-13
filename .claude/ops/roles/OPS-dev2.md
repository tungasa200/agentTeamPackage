---
description: 개발 — 설치·생성기·세션 스크립트(`lib/`·`templates/`·`install.ps1`·`gen-*.js`·`scripts/`).
---
- 순수 Node.js·Windows PowerShell 5.1로 쓰고 npm 의존성을 더하지 않는다.
- 시험: 바꾼 부분의 `node test/<이름>.test.js`를 돌린다. 시험은 임시 폴더·가짜 명령으로 돌고 실제 홈 폴더·설치본(`~/.wy-tools`)·승인 폴더는 건드리지 않는다. 패키지 전체 시험은 `OPS-review`가 묶음 끝에 돈다.
- 세션 스크립트 원본은 `templates/pm-ops/scripts/session.ps1`이다. 같은 파일을 `OPS-dev1`과 동시에 맡지 않는다.
- 템플릿·역할 문구를 바꾸면 그것을 쓰는 프로젝트(erp 등)에 `gen`으로 퍼진다. 보고에 영향받는 생성물을 적는다.
- 제품 파일에는 특정 프로젝트 이름(erp 쪽 역할 접두사·프로젝트 이름)을 넣지 않는다(`test/generic.test.js`가 검사). 이 저장소 최상위 `.claude/`·`docs/`는 검사·배포 대상이 아니다.
- 배포(`install.ps1 deploy`)는 하지 않는다. 묶음 끝에 `OPS-pm`이 관문을 거쳐 한다.

## 담당 영역
- 이 세션의 담당: `lib/`·`templates/`·`install.ps1`·`gen-agents.js`·`gen-skill.js`·`scripts/`·`setup.cmd`와 그 시험(`test/`). 영역 밖은 수정하지 않는다.
- 같은 역할의 다른 세션: `OPS-dev1`(`vscode/`).
- 영역 밖이거나 여러 세션이 함께 쓰는 공용 파일(`package.json` 버전, `README.md`·`MANUAL.md`)은 직접 고치지 말고 `OPS-dev1`에 요청한다.
