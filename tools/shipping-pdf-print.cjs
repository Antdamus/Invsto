/* Exact Windows queue, pinned portable PDF engine, no default-printer fallback. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
const pdf=require(fs.existsSync(path.join(__dirname,'shipping-pdf.js'))?'./shipping-pdf.js':'../shipping-pdf.js');
const manifest=require('./pdf-engine.json');
const isShippingPrinter=(name,model='')=>/\b5XL\b/i.test(`${name} ${model}`);
async function windowsPrinters(run=execute){
  const script="$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Printer | Select-Object Name,DriverName,WorkOffline,PrinterStatus) | ConvertTo-Json -Compress";
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});
  const parsed=JSON.parse(stdout.trim()||'[]');return Array.isArray(parsed)?parsed:[parsed];
}
async function printerState(printerName,run=execute){
  const printers=await windowsPrinters(run),printer=printers.find(row=>row.Name===printerName);
  return {connected:!!printer&&!printer.WorkOffline&&Number(printer.PrinterStatus)!==7,
    error:!printer?`Windows cannot find the paired printer "${printerName}".`:printer.WorkOffline||Number(printer.PrinterStatus)===7?'Windows reports this shipping printer offline. Connect and turn it on.':''};
}
let verifiedEngine;
function enginePath(root){
  const file=path.join(root,'pdf-engine','SumatraPDF.exe');
  if(!fs.existsSync(file))throw new Error('The shipping PDF engine is missing. Run the updated Windows helper installer.');
  const stat=fs.statSync(file),stamp=`${file}:${stat.size}:${stat.mtimeMs}`;
  if(verifiedEngine!==stamp){
    const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if(![manifest.x64.exeSha256,manifest.arm64.exeSha256].includes(hash))throw new Error('The shipping PDF engine failed verification. Run the updated installer.');
    verifiedEngine=stamp;
  }
  return file;
}
async function prepareJob(job,dataDir,root,{state=printerState,engine=enginePath}={}){
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(job.pdf_base64||'')||job.pdf_base64.length>Math.ceil(pdf.MAX_BYTES/3)*4)throw new Error('Invalid shipping PDF data.');
  const bytes=Buffer.from(job.pdf_base64,'base64');
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==job.pdf_sha256)throw new Error('Shipping PDF checksum mismatch.');
  await pdf.validate(bytes,job.pdf_page_count);
  const executable=engine(root),local=await state(job.printer_name);
  if(!local.connected)throw new Error(local.error||'Selected shipping printer is disconnected.');
  const directory=fs.mkdtempSync(path.join(dataDir,'shipping-'));
  const file=path.join(directory,'label.pdf');fs.writeFileSync(file,bytes,{mode:0o600});
  return {file,executable,cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})};
}
function printArguments(printerName,file){
  return ['-print-to',printerName,'-print-settings','shrink,monochrome,simplex,1x','-silent',file];
}
async function printPrepared(prepared,printerName,run=execute){
  await run(prepared.executable,printArguments(printerName,prepared.file),{windowsHide:true,timeout:60000,maxBuffer:1024*1024});
}
module.exports={isShippingPrinter,windowsPrinters,printerState,enginePath,prepareJob,printPrepared,printArguments};
