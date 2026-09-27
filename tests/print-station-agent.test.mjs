import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {processPrintJob,recoverPrintJob,validateJob}=require('../tools/print-station-agent.cjs');
const job=()=>({id:'job-a',claim_token:'claim-a',copies:2,printer_name:'DYMO A',label_xml:'<?xml version="1.0"?><DesktopLabel Version="1"></DesktopLabel>'});
function fixture(overrides={}){
 const state={journal:null,prints:0,reports:[]};
 const api={report:async(j,status,count,detail)=>{state.reports.push({status,count,detail});return {status};}};
 const options={api,printerName:'DYMO A',print:async()=>{state.prints++;},save:value=>{state.journal=structuredClone(value);},pause:async()=>{},...overrides};
 return {state,options};
}
test('worker submits the exact requested copy count and acknowledges without claiming physical completion',async()=>{
 const {state,options}=fixture();const result=await processPrintJob(job(),options);
 assert.equal(state.prints,2);assert.equal(result.status,'submitted');assert.equal(state.journal,null);
 assert.deepEqual(state.reports.map(r=>[r.status,r.count]),[['claimed',0],['claimed',1],['submitted',2]]);
});
test('lost final acknowledgement retries only the report, never the physical labels',async()=>{
 const {state,options}=fixture();let fail=true;
 options.api.report=async(j,status,count)=>{if(status==='submitted'&&fail)throw new Error('Network lost');return {status};};
 await assert.rejects(processPrintJob(job(),options),/Network lost/);
 assert.equal(state.prints,2);assert.equal(state.journal.status,'submitted');
 fail=false;await recoverPrintJob(state.journal,options);assert.equal(state.prints,2);assert.equal(state.journal,null);
});
test('ambiguous printer response stops remaining copies and is never automatically replayed',async()=>{
 const {state,options}=fixture();options.print=async()=>{state.prints++;throw new Error('Response lost after submission');};
 const result=await processPrintJob(job(),options);
 assert.equal(state.prints,1);assert.equal(result.status,'uncertain');assert.equal(result.submitted,0);
 assert.match(result.detail,/Check the printer/);
});
test('expired claim and wrong printer never submit a physical label',async()=>{
 for(const fault of ['expired','printer']){
  const {state,options}=fixture();if(fault==='expired')options.api.report=async(j,status)=>{if(status==='claimed')throw new Error('Claim expired');return {status};};else options.printerName='DYMO B';
  const result=await processPrintJob(job(),options);assert.equal(state.prints,0);assert.equal(result.status,'failed');
 }
});
test('restart with an unfinished durable journal reports uncertainty instead of resuming copies',async()=>{
 const {state,options}=fixture();await recoverPrintJob({job:job(),status:'working',submitted:1,inflight:true},options);
 assert.equal(state.prints,0);assert.equal(state.reports[0].status,'uncertain');assert.equal(state.reports[0].count,1);assert.equal(state.journal,null);
});
test('helper rejects non-label documents, external entities and excessive copies',()=>{
 for(const invalid of [{...job(),copies:101},{...job(),label_xml:'<script>not a label</script>'},{...job(),label_xml:'<!DOCTYPE x><DesktopLabel />'},{...job(),label_xml:'<DesktopLabel>'+('x'.repeat(2000001))+'</DesktopLabel>'}])assert.throws(()=>validateJob(invalid,'DYMO A'));
});

const dymo=require('../tools/dymo-web-service-print.js');
test('every copy sends the chosen roll in the real DYMO request parameters',async()=>{
 for(const roll of ['Left','Right']){
  const requests=[];const {options}=fixture({isTwinTurbo:true,print:(xml,copy,copies,selected)=>dymo.printLabel('https://localhost:41951','DYMO A',xml,copy,copies,selected,async(base,method,route,body)=>requests.push({method,route,params:new URLSearchParams(body)}))});
  const result=await processPrintJob({...job(),printer_roll:roll},options);
  assert.equal(result.status,'submitted');assert.equal(requests.length,2);
  for(const request of requests){assert.equal(request.method,'POST');assert.equal(request.route,'/PrintLabel');assert.equal(request.params.get('printerName'),'DYMO A');assert.equal(request.params.get('labelXml'),job().label_xml);assert.equal(request.params.get('printParamsXml'),`<LabelWriterPrintParams><TwinTurboRoll>${roll}</TwinTurboRoll></LabelWriterPrintParams>`);}
 }
});
test('invalid rolls and roll selection on a single-roll printer fail before submission',async()=>{
 for(const [roll,twin] of [['Auto',true],['Left',false],['Right',false],['<Right/>',true]]){
  const {state,options}=fixture({isTwinTurbo:twin});const result=await processPrintJob({...job(),printer_roll:roll},options);
  assert.equal(result.status,'failed');assert.equal(state.prints,0);assert.equal(state.reports.length,1);
 }
});
test('printer discovery identifies Twin Turbo hardware including renamed queues',()=>{
 const printers=dymo.parsePrinters('<Printers><LabelWriterPrinter><Name>Counter</Name><ModelName>DYMO LabelWriter 450 Twin Turbo</ModelName><IsConnected>True</IsConnected></LabelWriterPrinter><LabelWriterPrinter><Name>Other</Name><IsTwinTurbo>True</IsTwinTurbo></LabelWriterPrinter><LabelWriterPrinter><Name>DYMO 450</Name><IsTwinTurbo>False</IsTwinTurbo></LabelWriterPrinter></Printers>');
 assert.deepEqual(printers.map(p=>p.isTwinTurbo),[true,true,false]);
});
