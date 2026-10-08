// 껍데기 폴더를 vsix(zip)로: extension.vsixmanifest, [Content_Types].xml, extension/… (vsce·npm 없이. U-11 시험으로 code CLI 설치 확인)
//   vsix(stubDir) → Buffer
const fs = require('fs');
const path = require('path');
const { zip } = require('./zip');

const TYPES = { json: 'application/json', js: 'application/javascript', vsixmanifest: 'text/xml', svg: 'image/svg+xml', png: 'image/png', md: 'text/markdown' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function vsix(stubDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(stubDir, 'package.json'), 'utf8'));
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description || '')}</Description>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" /></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
`;
  const types = Object.entries(TYPES).map(([x, t]) => `<Default Extension=".${x}" ContentType="${t}" />`).join('');
  const entries = [
    { name: 'extension.vsixmanifest', data: manifest },
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types}</Types>` },
  ];
  (function walk(d, rel) {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n);
      if (fs.statSync(f).isDirectory()) walk(f, `${rel}${n}/`);
      else entries.push({ name: `extension/${rel}${n}`, data: fs.readFileSync(f) });
    }
  })(stubDir, '');
  return zip(entries);
}

module.exports = { vsix };
