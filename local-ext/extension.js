// WY Ops 접속 PC 소리(0.8.4): Remote-SSH 원격 창에서 승인 센터 새 카드 소리를 접속 PC 스피커로 낸다.
// 승인 센터 확장(wy-ops.wy-ops)은 원격 창에서 호스트 쪽 확장 호스트에서 돌아, 거기서 소리를 내면 호스트 스피커로 나간다.
// 이 확장은 extensionKind ui라 늘 접속 PC에서 돌고, VS Code가 원격 쪽의 executeCommand('wyOps.playLocalSound')를 이쪽으로 넘겨준다.
// install.ps1 connect가 접속 PC에 설치한다. 설치본을 불러오지 않는 독립 확장이라, 고치면 package.json version을 올린다(connect가 버전으로 다시 설치).
const { spawn } = require('child_process');
const path = require('path');

function soundCommand(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const wav = path.join(env.SystemRoot || 'C:\\Windows', 'Media', 'Windows Notify System Generic.wav');
    const script = `$p='${wav.replace(/'/g, "''")}'; if (Test-Path -LiteralPath $p) { (New-Object System.Media.SoundPlayer $p).PlaySync() } else { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 800 }`;
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]];
  }
  if (platform === 'darwin') return ['afplay', ['/System/Library/Sounds/Glass.aiff']];
  return ['paplay', ['/usr/share/sounds/freedesktop/stereo/message.oga']];
}

function play() {
  const [cmd, args] = soundCommand();
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 소리는 덤이다
  }
}

function activate(context) {
  const vscode = require('vscode');
  context.subscriptions.push(vscode.commands.registerCommand('wyOps.playLocalSound', () => play()));
}

function deactivate() {}

module.exports = { activate, deactivate, soundCommand };
