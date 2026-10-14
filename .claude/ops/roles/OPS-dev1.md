---
description: 개발 — VS Code 확장(`vscode/`: 세션 현황·승인 센터·활동 탭, 훅 `vscode/hooks/`). 같은 역할의 공용 파일 담당.
---
- 확장은 순수 JavaScript, npm 의존성 없이 쓴다. Extension Development Host는 띄우지 않고 가짜 `vscode` 모듈로 로드·동작을 시험한다(`vscode/test/`).
- 시험: 바꾼 파일의 `node vscode/test/<이름>.test.js`를 돌린다. 패키지 전체 시험은 `OPS-review`가 묶음 끝에 돈다.
- 훅(`vscode/hooks/`)은 다른 프로젝트(erp 등)의 커밋 관문과 메시지 가드에도 그대로 쓰인다. 훅을 바꾸면 보고에 "다른 프로젝트 커밋 관문에 영향"을 적는다.
- 제품 파일에는 특정 프로젝트 이름(erp 쪽 역할 접두사·프로젝트 이름)을 넣지 않는다(`test/generic.test.js`가 검사). 역할 이름은 설정(`wy-ops.json`)에서 읽는다.
- 배포(`install.ps1 deploy`)는 하지 않는다. 묶음 끝에 `OPS-pm`이 관문(전체 시험·doctor·`OPS-review` 점검·사용자 승인)을 거쳐 한다.

## 담당 영역
- 이 세션의 담당: `vscode/`(확장·훅·확장 시험). 영역 밖은 수정하지 않는다.
- 같은 역할의 다른 세션: `OPS-dev2`(`lib/`·`templates/`·`install.ps1`·`gen-*.js`·세션 스크립트).
- 여러 세션이 함께 쓰는 공용 파일(`package.json` 버전, `README.md`·`MANUAL.md`)은 이 세션이 맡는다. 다른 세션의 요청을 받아 고치고 결과를 알린다.
