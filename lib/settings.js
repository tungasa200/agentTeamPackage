// .claude/settings.local.json 병합(OPS-10, install.ps1 setup·init이 부른다)
//   템플릿(templates/settings.hooks.json)의 deny 줄과 훅(템플릿의 hooks 전부)을 넣는다. 다른 키·allow는 건드리지 않는다.
//   이미 있는 훅이 같은 스크립트를 다른 경로(옛 설치본 ~/.wy-tools/vscode-dashboard 등)로 가리키면 새 경로로 바꾼다.
//   plan은 쓰지 않고 바뀔 것만 돌려준다. apply는 .bak-<시각>을 남기고 임시 파일 → 이름 바꾸기로 쓴다.
// CLI: node settings.js plan|apply <settings 파일> <훅 폴더>   (훅 폴더 예: C:/Users/me/.wy-tools/wy-ops/current/vscode/hooks)
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'settings.hooks.json');
const slash = (p) => String(p).replace(/\\/g, '/');

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const s = JSON.parse(raw);
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('settings가 객체가 아님');
  return s;
}

// 따옴표를 지키며 명령 문자열을 조각낸다. 짝이 안 맞는 따옴표면 null
function splitCommand(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of String(cmd)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started || cur) out.push(cur);
  return out;
}

const isAbsolute = (p) => /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(p);

// 훅 명령이 가리키는 스크립트 경로(args 형식과 "node 경로" 문자열 형식 모두).
//   { script, unknown }: args가 있으면 마지막 인자. command만 있으면 따옴표를 지켜 자른 뒤 .js로 끝나는 마지막 조각.
//   그 조각이 절대 경로가 아니거나(따옴표 없이 공백 든 경로가 끊긴 경우) 따옴표 짝이 안 맞으면 unknown — 부르는 쪽이 안전한 쪽으로 판단한다
function hookScriptInfo(h) {
  if (!h || typeof h !== 'object') return { script: null, unknown: false };
  if (Array.isArray(h.args) && h.args.length) return { script: slash(h.args[h.args.length - 1]), unknown: false };
  const command = String(h.command || '');
  if (!/\.js\b/i.test(command)) return { script: null, unknown: false };
  const parts = splitCommand(command);
  const js = parts && parts.filter((p) => /\.js$/i.test(p)).pop();
  if (!js || !isAbsolute(js)) return { script: null, unknown: true };
  return { script: slash(js), unknown: false };
}

function scriptOf(h) {
  return hookScriptInfo(h).script;
}

function plan(current, hooksDir, template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'))) {
  const next = JSON.parse(JSON.stringify(current || {}));
  const changes = [];
  next.permissions = next.permissions || {};
  next.permissions.deny = Array.isArray(next.permissions.deny) ? next.permissions.deny : [];
  for (const d of template.deny) {
    if (!next.permissions.deny.includes(d)) {
      next.permissions.deny.push(d);
      changes.push({ type: 'deny-add', value: d });
    }
  }
  next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
  const dir = slash(hooksDir).replace(/\/+$/, '');
  for (const t of template.hooks) {
    const want = `${dir}/${t.script}`;
    const list = (next.hooks[t.event] = Array.isArray(next.hooks[t.event]) ? next.hooks[t.event] : []);
    const group = list.find((g) => (g.matcher || null) === (t.matcher || null) && (g.hooks || []).some((h) => path.posix.basename(scriptOf(h) || '') === t.script));
    if (group) {
      const h = group.hooks.find((x) => path.posix.basename(scriptOf(x) || '') === t.script);
      const have = scriptOf(h);
      if (have === want && h.timeout === t.timeout) continue;
      const before = `node ${have}${h.timeout ? `, timeout ${h.timeout}` : ''}`;
      Object.assign(h, { type: 'command', command: 'node', args: [want], timeout: t.timeout });
      changes.push({ type: 'hook-update', event: t.event, matcher: t.matcher || null, from: before, to: `node ${want}, timeout ${t.timeout}` });
      continue;
    }
    const hook = { type: 'command', command: 'node', args: [want], timeout: t.timeout };
    list.push(t.matcher ? { matcher: t.matcher, hooks: [hook] } : { hooks: [hook] });
    changes.push({ type: 'hook-add', event: t.event, matcher: t.matcher || null, to: `node ${want}, timeout ${t.timeout}` });
  }
  return { next, changes };
}

// 사람이 읽을 한 줄씩
function describe(c) {
  const where = c.matcher ? `${c.event}(${c.matcher})` : c.event;
  if (c.type === 'deny-add') return `+ deny ${c.value}`;
  if (c.type === 'hook-add') return `+ 훅 ${where}: ${c.to}`;
  return `~ 훅 ${where}: ${c.from} → ${c.to}`;
}

function apply(file, next, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${stamp}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8')); // 쓴 것이 JSON인지 확인
  fs.renameSync(tmp, file);
  return fs.existsSync(`${file}.bak-${stamp}`) ? `${file}.bak-${stamp}` : null;
}

if (require.main === module) {
  const [cmd, file, hooksDir] = process.argv.slice(2);
  if (!['plan', 'apply'].includes(cmd) || !file || !hooksDir) {
    console.error('사용법: node settings.js plan|apply <settings 파일> <훅 폴더>');
    process.exit(64);
  }
  for (const f of ['wy-approval-guard.js', 'wy-message-guard.js', 'wy-permission.js', 'wy-session-start.js', 'wy-context-size.js']) {
    if (!fs.existsSync(path.join(hooksDir, f))) {
      console.error(`훅 파일이 없습니다: ${path.join(hooksDir, f)} — 먼저 install.ps1 deploy`);
      process.exit(2); // 경로가 없으면 훅이 조용히 통과하므로 쓰지 않는다
    }
  }
  const { next, changes } = plan(readSettings(file), hooksDir);
  if (!changes.length) {
    console.log('바꿀 것 없음');
    process.exit(0);
  }
  console.log(changes.map(describe).join('\n'));
  if (cmd === 'apply') {
    const bak = apply(file, next);
    console.log(bak ? `백업: ${bak}` : '새 파일을 만들었습니다');
  }
}

module.exports = { plan, apply, describe, readSettings, scriptOf, hookScriptInfo, splitCommand };
