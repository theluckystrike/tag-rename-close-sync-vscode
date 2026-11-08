// Writes the gate's generated files into <dir>: a 60,000-line HTML page, a 60,000-line Vue file, 5,000 nested divs,
// and a stub language extension (vsix) that only registers the vue, svelte, twig and blade language ids, as the
// Vue, Svelte, Twig and Blade extensions do. Large files live in ~/auto-rename-tag-work, never in the temp folder.
// usage: node scripts/make-fixtures.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = path.resolve(process.argv[2]);
fs.mkdirSync(dir, { recursive: true });

const rows = (n) => Array.from({ length: n }, (_, i) => `    <div class="row" data-i="${i}"><span class="n">${i}</span> <em>item ${i}</em></div>`).join('\n');
const big = rows(60000);
fs.writeFileSync(path.join(dir, 'large-60k.html'), `<!doctype html>\n<html>\n<head><title>60,000 rows</title></head>\n<body>\n  <main id="rows">\n${big}\n  </main>\n</body>\n</html>\n`);
fs.writeFileSync(path.join(dir, 'large-60k.vue'), `<template>\n  <main id="rows">\n${big}\n  </main>\n</template>\n`);
const n = 5000;
fs.writeFileSync(path.join(dir, 'nested-5000.html'), '<div>\n' + '<div>'.repeat(n - 1) + 'deep' + '</div>'.repeat(n - 1) + '\n</div>\n');

// stub language extension
const stub = path.join(dir, 'langstub');
fs.rmSync(stub, { recursive: true, force: true });
fs.mkdirSync(path.join(stub, 'extension'), { recursive: true });
fs.writeFileSync(path.join(stub, 'extension', 'package.json'), JSON.stringify({
  name: 'gate-language-ids', publisher: 'zovo-gate', version: '0.0.1', engines: { vscode: '^1.60.0' },
  contributes: { languages: [
    { id: 'vue', aliases: ['Vue'], extensions: ['.vue'] },
    { id: 'svelte', aliases: ['Svelte'], extensions: ['.svelte'] },
    { id: 'twig', aliases: ['Twig'], extensions: ['.twig'] },
    { id: 'blade', aliases: ['Blade'], filenamePatterns: ['*.blade.php'] },
  ] },
}, null, 1));
fs.writeFileSync(path.join(stub, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="gate-language-ids" Version="0.0.1" Publisher="zovo-gate"/><DisplayName>gate-language-ids</DisplayName><Description xml:space="preserve">gate</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.60.0"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`);
fs.writeFileSync(path.join(stub, '[Content_Types].xml'), '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>');
const out = path.join(dir, 'gate-language-ids.vsix');
fs.rmSync(out, { force: true });
execFileSync('zip', ['-q', '-r', out, '.'], { cwd: stub });
for (const f of fs.readdirSync(dir)) console.log(f, fs.statSync(path.join(dir, f)).size);
