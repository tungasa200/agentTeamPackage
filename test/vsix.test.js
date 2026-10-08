// zip 작성기·vsix 묶기 검사: 만든 zip을 다시 읽어(중앙 디렉터리 → 로컬 헤더 → inflate) 이름·내용·CRC가 같은지
//   node tools/wy-ops/test/vsix.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmTree } = require('../lib/fsx');
const zlib = require('zlib');
const { zip, crc32 } = require('../lib/zip');
const { vsix } = require('../lib/vsix');
const stub = require('../lib/stub');

// 최소 zip 읽기(이 테스트용)
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'EOCD 있음');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, '중앙 디렉터리 서명');
    const flags = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    assert.strictEqual(flags & 0x0800, 0x0800, 'UTF-8 이름 표시');
    assert.strictEqual(buf.readUInt32LE(off), 0x04034b50, '로컬 헤더 서명');
    const lnlen = buf.readUInt16LE(off + 26);
    const data = zlib.inflateRawSync(buf.slice(off + 30 + lnlen, off + 30 + lnlen + csize));
    assert.strictEqual(crc32(data), crc, `${name} CRC`);
    out[name] = data;
    p += 46 + nlen;
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-vsix-'));
try {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC32 표준 검사값');
  const z = unzip(zip([{ name: 'a/한글.txt', data: '가나다' }, { name: 'b.bin', data: Buffer.alloc(5000, 7) }]));
  assert.strictEqual(z['a/한글.txt'].toString('utf8'), '가나다');
  assert.strictEqual(z['b.bin'].length, 5000);

  // 이 저장소의 확장으로 껍데기를 만들어 vsix로: manifest·Content_Types·extension/ 아래 파일
  const out = path.join(tmp, 'stub');
  const { hash } = stub.build(path.join(__dirname, '..', 'vscode'), out);
  const v = unzip(vsix(out));
  assert.ok(v['extension.vsixmanifest'].toString().includes('Id="wy-ops"') && v['extension.vsixmanifest'].toString().includes('Publisher="wy-ops"'));
  assert.ok(v['[Content_Types].xml'].toString().includes('.json'));
  const pkg = JSON.parse(v['extension/package.json']);
  assert.deepStrictEqual([pkg.main, pkg.wyOpsStubHash], ['./stub.js', hash]);
  assert.ok(v['extension/stub.js'] && v['extension/media/icon.svg'], '껍데기와 아이콘');
  console.log('wy-ops vsix 검사 통과');
} finally {
  rmTree(tmp);
}
