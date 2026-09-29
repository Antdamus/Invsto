import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const require=createRequire(import.meta.url);
const {PDFDocument}=require('../vendor/pdf-lib/pdf-lib.min.js');
const pdf=require('../shipping-pdf.js');
const shipping=require('../tools/shipping-pdf-print.cjs');
const {processPrintJob,profileDirectories,profileDirectory}=require('../tools/print-station-agent.cjs');
async function fixture(sizes=[[288,432]]){const doc=await PDFDocument.create();sizes.forEach(size=>doc.addPage(size));return doc.save();}
async function job(){const {bytes}=await pdf.prepare(await fixture(),'1');return {id:'pdf-job',claim_token:'claim',document_type:'pdf',copies:2,printer_name:'DYMO LabelWriter 5XL',printer_roll:'default',pdf_page_count:1,pdf_base64:Buffer.from(bytes).toString('base64'),pdf_sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}
test('page selection is explicit, bounded and removes duplicate pages',()=>{
 assert.deepEqual(pdf.parsePages('3, 1-2, 2',4),[1,2,3]);assert.deepEqual(pdf.parsePages('all',3),[1,2,3]);
 for(const value of ['',0,'1-999','4-2','1,','2.5','<1>'])assert.throws(()=>pdf.parsePages(value,4));
});
test('normalize only selected 4x6 pages; output deterministic for safe retries',async()=>{
 const bytes=await fixture([[288,432],[612,792],[432,288]]);
 const first=await pdf.prepare(bytes,'1,3'),second=await pdf.prepare(bytes,'1,3');
 assert.equal(first.pageCount,2);assert.deepEqual(first.bytes,second.bytes);await pdf.validate(first.bytes,2);
 await assert.rejects(pdf.prepare(bytes,'all'),/Page 2.*4 × 6/);await assert.rejects(pdf.validate(first.bytes,1),/page count/);
});
test('letter-sized sheets cannot sneak through a 4x6 crop',async()=>{
 const doc=await PDFDocument.create(),page=doc.addPage([612,792]);page.setCropBox(0,0,288,432);
 await assert.rejects(pdf.prepare(await doc.save(),'1'),/4 × 6/);
 await assert.rejects(pdf.inspect(new TextEncoder().encode('not a PDF')),/cannot be read/);
 await assert.rejects(pdf.inspect(new Uint8Array(pdf.MAX_BYTES+1)),/10 MB/);
});
test('Windows PDF readiness uses exact queue without selecting a duplicate or default',async()=>{
 const run=async()=>({stdout:JSON.stringify([{Name:'5XL (Copy 1)',WorkOffline:true,PrinterStatus:7},{Name:'5XL',WorkOffline:false,PrinterStatus:3}])});
 assert.equal((await shipping.printerState('5XL',run)).connected,true);
 assert.equal((await shipping.printerState('5XL (Copy 1)',run)).connected,false);
 assert.equal((await shipping.printerState('Absent',run)).connected,false);
 const args=shipping.printArguments('DYMO " shipping & printer', 'C:\\labels\\file.pdf');assert.deepEqual(args.slice(0,2),['-print-to','DYMO " shipping & printer']);assert.equal(args.includes('-print-to-default'),false);
});
test('PDF checksum/readiness failures fail before submission; ambiguous spool response is uncertain',async()=>{
 const document=await job();let prints=0;
 const api={report:async(j,status)=>({status})};
 const options={api,printerName:document.printer_name,print:async()=>{prints++;},save:()=>{},pause:async()=>{}};
 const temp=mkdtempSync(path.join(os.tmpdir(),'invsto-pdf-test-'));
 try {
  const prepare=job=>shipping.prepareJob(job,temp,temp,{engine:()=>'/test/engine',state:async()=>({connected:true})});
  let result=await processPrintJob({...document,pdf_sha256:'bad'},{...options,prepare});assert.equal(result.status,'failed');assert.equal(prints,0);
  result=await processPrintJob(document,{...options,prepare,print:async()=>{prints++;throw new Error('spool response lost');}});assert.equal(result.status,'uncertain');assert.equal(prints,1);
  result=await processPrintJob(document,{...options,prepare});assert.equal(result.status,'submitted');assert.equal(prints,3);
  result=await processPrintJob({...document,printer_name:'Twin Turbo'},{...options,printerName:'Twin Turbo',prepare});assert.equal(result.status,'failed');assert.equal(prints,3);
 } finally {rmSync(temp,{recursive:true,force:true});}
});
test('profiles isolate printer credentials and reject directory traversal',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'invsto-profiles-test-')),id=crypto.randomUUID();
 try {const extra=profileDirectory(root,id);mkdirSync(extra,{recursive:true});writeFileSync(path.join(root,'station.json'),'original');writeFileSync(path.join(extra,'station.json'),'second');
  assert.deepEqual(profileDirectories(root),[root,extra]);assert.throws(()=>profileDirectory(root,'../../elsewhere'),/Invalid/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
