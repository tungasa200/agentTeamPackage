// 끊긴 SSH 접속이 남긴 묶음: 세션 현황 줄·[정리]·자동 정리(0.11.0).
// 판정·끄기는 설치본 ssh-orphans.ps1 한 곳(30분 규칙·끄기 직전 다시 판정 포함). 여기는 언제 부를지만 정한다.
// SSH 원격 옵션(install.ps1 host)을 하지 않은 PC에서는 스크립트를 부르지 않는다 → 줄·버튼·자동 정리 모두 없음.
const fs = require('fs');

const TIMEOUT = 30000;
const AUTO_GAP_MS = 10 * 60 * 1000; // 자동 정리는 10분에 한 번까지(후보 판정은 60초마다)
// install.ps1 host가 HKLM\SOFTWARE\OpenSSH DefaultShell을 Windows PowerShell로 바꾼다(lib/host.js shellOk와 같은 규칙).
// 일반 권한으로도 읽히는 값이라 호스트에서 직접 연 창에서도 같은 답이 나온다
const HOST_KEY = ['query', 'HKLM\\SOFTWARE\\OpenSSH', '/v', 'DefaultShell'];
const SHELL_RE = /DefaultShell\s+REG_\w+\s+.*\\powershell\.exe\s*$/im;

const psArgs = (file, extra = []) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Json', ...extra];

function lastJson(out) {
  const line = String(out).split(/\r?\n/).filter((l) => l.trim().replace(/^﻿/, '').startsWith('{')).pop();
  return line ? JSON.parse(line.trim().replace(/^﻿/, '')) : null;
}

async function isSshHost(run) {
  try {
    return SHELL_RE.test(await run('reg', 'reg.exe', HOST_KEY, 5000));
  } catch {
    return false; // 키 없음(reg 종료 코드 1) = host를 하지 않은 PC
  }
}

class OrphanCleaner {
  // run(label, file, args, timeout) → stdout. now는 시험용
  constructor({ file, run, now = Date.now, autoGapMs = AUTO_GAP_MS }) {
    this.file = file;
    this.run = run;
    this.now = now;
    this.autoGapMs = autoGapMs;
    this.host = null; // 창마다 한 번만 확인(host를 나중에 했으면 창을 다시 열면 보임)
    this.lastAuto = 0;
    this.stopping = null;
  }

  enabled() {
    if (!fs.existsSync(this.file)) return Promise.resolve(false);
    if (!this.host) this.host = isSshHost(this.run);
    return this.host;
  }

  // 줄에 쓸 값 {count, mb, admin}. host 아님·스크립트 없음·실패·이상한 출력은 null(줄을 숨긴다, 오류로 띄우지 않음)
  async read() {
    if (!(await this.enabled())) return null;
    try {
      const o = lastJson(await this.run('ssh-orphans', 'powershell.exe', psArgs(this.file), TIMEOUT));
      const c = o && o.candidates;
      return c ? { count: Number(c.count) || 0, mb: Number(c.mb) || 0, admin: o.admin === true } : null;
    } catch {
      return null;
    }
  }

  // 끄기. kind: 'manual'([정리]) | 'auto'. 결과 {kind, at, count, mb, failed} 또는 {kind, at, error}
  stop(kind) {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const at = this.now();
      try {
        if (!(await this.enabled())) return { kind, at, error: 'SSH 원격 호스트가 아닙니다' };
        const o = lastJson(await this.run('ssh-orphans', 'powershell.exe', psArgs(this.file, ['-Stop']), TIMEOUT));
        if (!o) return { kind, at, error: '결과를 읽지 못했습니다' };
        if (o.admin !== true) return { kind, at, error: '관리자 권한이 필요합니다' };
        const sc = o.stoppedChains || { count: 0, mb: 0 };
        const failed = (o.stopped || []).filter((s) => s && s.ok === false).length;
        return { kind, at, count: Number(sc.count) || 0, mb: Number(sc.mb) || 0, failed };
      } catch (err) {
        return { kind, at, error: String((err && err.message) || err).split(/\r?\n/)[0] };
      } finally {
        this.stopping = null;
      }
    })();
    return this.stopping;
  }

  // 판정 결과를 보고 자동 정리할지: 관리자 창·후보 있음·지난 자동 정리에서 autoGapMs 지남. 안 하면 null
  maybeAuto(data) {
    if (!data || !data.admin || !data.count || this.stopping) return null;
    if (this.lastAuto && this.now() - this.lastAuto < this.autoGapMs) return null;
    this.lastAuto = this.now();
    return this.stop('auto');
  }
}

module.exports = { OrphanCleaner, isSshHost, lastJson, AUTO_GAP_MS, HOST_KEY };
