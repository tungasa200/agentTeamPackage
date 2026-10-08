// 승인 센터 새 카드 소리 알림(진행현황 14번, 사용자 요청 2026-10-07).
// 웹뷰 오디오는 사용자 조작 전 재생이 막힐 수 있고 탭이 닫혀 있으면 아예 없으므로, 확장 호스트에서 OS 기본 알림음을 낸다.
// 설정 wyOps.approvals.sound(기본 켜짐)로 끈다.
const { spawn } = require('child_process');
const path = require('path');

const GAP = 5000; // 이 간격 안에 또 들어온 카드는 소리를 다시 내지 않는다(여러 장이 한꺼번에 와도 한 번)

// OS별 알림음 명령. 소리 파일이 없거나 명령이 없으면 조용히 넘어간다
function soundCommand(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const wav = path.join(env.SystemRoot || 'C:\\Windows', 'Media', 'Windows Notify System Generic.wav');
    // SoundPlayer.PlaySync는 끝까지 재생하고 나간다. 파일이 없으면 시스템 소리(비동기라 잠깐 기다린다)
    const script = `$p='${wav.replace(/'/g, "''")}'; if (Test-Path -LiteralPath $p) { (New-Object System.Media.SoundPlayer $p).PlaySync() } else { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 800 }`;
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]];
  }
  if (platform === 'darwin') return ['afplay', ['/System/Library/Sounds/Glass.aiff']];
  return ['paplay', ['/usr/share/sounds/freedesktop/stereo/message.oga']];
}

function playSystemSound() {
  const [cmd, args] = soundCommand();
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: false });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 소리는 덤이다. 실패해도 승인 센터는 그대로
  }
}

// 처음 받은 목록은 기준으로만 삼는다(VS Code를 켤 때 쌓여 있던 카드로 울리지 않게). 그 뒤 새 id가 보이면 한 번 울린다.
class ArrivalBell {
  constructor({ play = playSystemSound, now = Date.now, enabled = () => true, gap = GAP } = {}) {
    this.play = play;
    this.now = now;
    this.enabled = enabled;
    this.gap = gap;
    this.seen = null;
    this.last = -Infinity;
  }

  // ids: 지금 결정을 기다리는 카드 id. 소리를 냈으면 true
  update(ids) {
    const fresh = this.seen ? ids.filter((id) => !this.seen.has(id)) : [];
    this.seen = new Set(ids);
    if (!fresh.length || !this.enabled()) return false;
    const t = this.now();
    if (t - this.last < this.gap) return false;
    this.last = t;
    this.play();
    return true;
  }
}

module.exports = { ArrivalBell, soundCommand, playSystemSound, GAP };
