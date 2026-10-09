import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context={URL,Blob,TextEncoder,Uint8Array,DataView};vm.createContext(context);
vm.runInContext(await readFile(new URL('../customer-issue-evidence.js',import.meta.url),'utf8'),context);
const api=context.OGIssueEvidence.testing;
test('archive keeps original bytes and emits a valid directory and CRC',async()=>{
 const content=new TextEncoder().encode('original photo bytes');
 const blob=api.zip([{name:'files/photo.jpg',bytes:content},{name:'report.html',bytes:new TextEncoder().encode('<h1>Report</h1>')}]);
 const bytes=new Uint8Array(await blob.arrayBuffer()),view=new DataView(bytes.buffer);
 assert.equal(view.getUint32(0,true),0x04034b50);
 const nameLength=view.getUint16(26,true);assert.deepEqual(bytes.slice(30+nameLength,30+nameLength+content.length),content);
 assert.equal(view.getUint32(14,true),api.crc(content));
 assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);assert.equal(view.getUint16(bytes.length-12,true),2);
 const directory=view.getUint32(bytes.length-6,true);assert.equal(view.getUint32(directory,true),0x02014b50);
});
test('evidence collection deduplicates shared photos without including arbitrary staff attachments',()=>{
 const files=api.collect({bag_photos:[{bucket:'photos',path:'a.jpg'}],reference_events:[{photo_attachments:[{bucket:'photos',path:'private.jpg'}]}],certificates:[{attachments:[{bucket:'documents',path:'cert.pdf'}]}]},[{bucket:'photos',path:'a.jpg'}],[]);
 assert.equal(files.length,2);assert.ok(!files.some(f=>f.path==='private.jpg'));
});
test('download report escapes message markup and flags missing evidence',()=>{
 const result=api.report({case:{buyer_username:'<script>alert(1)</script>'},certificates:[{certificate_url:'javascript:alert(1)'}]},[],[{message_body:'<img src=x onerror=alert(1)>'}],['Photo could not download']);
 assert.ok(result.includes('&lt;script&gt;'));assert.ok(!result.includes('<script>'));assert.ok(!result.includes('href="javascript:'));assert.ok(result.includes('Incomplete download'));
});
