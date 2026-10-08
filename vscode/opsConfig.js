// wy-ops 프로젝트 설정을 읽는다: <저장소>/.claude/wy-ops.json(커밋) 위에 .claude/wy-ops.local.json(PC별)을 덮어쓴다.
// 시작 폴더에서 위로 올라가며 찾고, 없거나 읽지 못하면 null을 돌려준다(부르는 쪽이 지금 값으로 대체한다).
const fs = require('fs');
const path = require('path');

const CONFIG = path.join('.claude', 'wy-ops.json');
const LOCAL = path.join('.claude', 'wy-ops.local.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// 객체는 키별로 합치고, 배열·값은 덮어쓴다
function merge(base, over) {
  if (!isObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  return out;
}

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function loadOpsConfig(start) {
  const root = start ? findProjectRoot(start) : null;
  if (!root) return null;
  const base = readJson(path.join(root, CONFIG));
  if (!isObject(base)) return null;
  return { ...merge(base, readJson(path.join(root, LOCAL))), root };
}

module.exports = { loadOpsConfig, findProjectRoot };
