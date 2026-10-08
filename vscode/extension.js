// wy-ops 확장의 진입점. 각 화면 모듈을 등록만 한다(공용 연결 파일).
//   sessionsView  세션 현황 사이드바
//   approvalCenter 승인 센터 탭·상태 표시줄
//   activityView  활동 탭
const vscode = require('vscode');
const sessionsView = require('./sessionsView');
const { ApprovalCenter } = require('./approvalCenter');
const activityView = require('./activityView');

// 한 화면이 실패해도 나머지는 계속 쓸 수 있게 따로 띄운다
function safely(label, fn) {
  try {
    fn();
  } catch (err) {
    vscode.window.showErrorMessage(`${label}을(를) 시작하지 못했습니다: ${err.message}`);
  }
}

function activate(context) {
  safely('세션 현황', () => sessionsView.register(context));
  safely('WY 승인 센터', () => new ApprovalCenter(context));
  safely('활동 탭', () => activityView.register(context));
}

function deactivate() {}

module.exports = { activate, deactivate };
