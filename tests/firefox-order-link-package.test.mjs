import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

test('Firefox package includes every entry point and parses without a service worker',async t=>{
 const output=await mkdtemp(join(tmpdir(),'og-firefox-package-'));
 t.after(()=>rm(output,{recursive:true,force:true}));
 const builder=fileURLToPath(new URL('../tools/build-firefox-order-link-package.py',import.meta.url));
 const originalManifest=await readFile(new URL('../tools/ebay-og-order-link-extension/manifest.json',import.meta.url),'utf8');
 execFileSync('python',[builder,'--output',output],{encoding:'utf8'});
 const archive=join(output,'OG-Order-Link-Firefox-unsigned.zip');
 const files=JSON.parse(execFileSync('python',['-c',
  "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode('utf-8') for n in z.namelist()}))",archive],{encoding:'utf8',maxBuffer:2*1024*1024}));
 const manifest=JSON.parse(files['manifest.json']);
 assert.equal(manifest.background.service_worker,undefined);
 assert.ok(manifest.background.scripts.includes('tiktok-receipt-background.js'));
 assert.ok(manifest.background.scripts.includes('performance-background.js'));
 assert.equal(manifest.browser_specific_settings.gecko.id,'og-order-link@invsto.app');
 const entries=[...manifest.background.scripts,manifest.options_page,manifest.action.default_popup,
  ...manifest.content_scripts.flatMap(entry=>[...(entry.js||[]),...(entry.css||[])]),
  ...manifest.web_accessible_resources.flatMap(entry=>entry.resources)];
 for(const name of entries)assert.ok(files[name],`packaged entry point ${name}`);
 for(const [name,source] of Object.entries(files))if(name.endsWith('.js'))new vm.Script(source,{filename:name});
 const probe=await readFile(new URL('../tools/ebay-og-order-link-extension/tiktok-print-probe.js',import.meta.url),'utf8');
 assert.equal(files['tiktok-print-probe.js'],probe.replaceAll('\r\n','\n'),'page-world probe is not wrapped in extension APIs');
 assert.equal(await readFile(new URL('../tools/ebay-og-order-link-extension/manifest.json',import.meta.url),'utf8'),originalManifest);
 const metadata=JSON.parse(await readFile(join(output,'firefox-package.json'),'utf8'));
 assert.equal(metadata.signed,false,'unsigned development package must not be described as installed or signed');
});
