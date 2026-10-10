// Read-only eBay retrieval, with a private, reusable copy in our evidence bucket.
// Call only after authenticating the employee and checking visibility of the case.
const MAX_BYTES = 10 * 1024 * 1024;
const BUCKET = 'ebay-return-evidence';
const checked = (r:any) => { if(r.error) throw r.error; return r.data; };

export function disputeFile(c:any, evidenceId:unknown, fileId:unknown) {
 const d=c?.raw_payload?.ebayDetail;
 if(c?.source_lane!=='payment_dispute'||!d?.paymentDisputeId||String(d.paymentDisputeId)!==String(c.ebay_return_id))throw Error('Payment dispute not found.');
 if(typeof evidenceId!=='string'||typeof fileId!=='string'||!evidenceId||!fileId)throw Error('Choose a saved dispute document.');
 const evidence=Array.isArray(d.evidence)?d.evidence.find((e:any)=>e.evidenceId===evidenceId):null;
 const file=Array.isArray(evidence?.files)?evidence.files.find((f:any)=>f.fileId===fileId):null;
 if(!file)throw Error('This document does not belong to the selected dispute.');
 return file;
}
export function evidenceMime(bytes:Uint8Array) {
 if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
 if([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return 'image/png';
 if(String.fromCharCode(...bytes.slice(0,6)).match(/^GIF8[79]a$/))return 'image/gif';
 if(String.fromCharCode(...bytes.slice(0,5))==='%PDF-')return 'application/pdf';
 if(String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';
 throw Error('eBay did not return a supported image or PDF. Open the document on eBay.');
}
export async function boundedEvidence(response:Response) {
 if(!response.ok){
  // Include only the provider's numeric diagnostic, never its raw response body.
  let code='';const reader=response.body?.getReader();
  if(reader)try{let text='';while(text.length<4096){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value.slice(0,4096-text.length));}const error=JSON.parse(text)?.errors?.[0];if(/^\d{1,8}$/.test(String(error?.errorId||'')))code=` / eBay ${error.errorId}`;const reason=error?.parameters?.find((p:any)=>p.name==='code')?.value;if(/^\d{3}$/.test(String(reason||'')))code+=` / upstream ${reason}`;}catch{}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  throw Error(`eBay could not retrieve this document (${response.status}${code}). Please retry or open it on eBay.`);
 }
 if(Number(response.headers.get('Content-Length'))>MAX_BYTES){await response.body?.cancel();throw Error('Document exceeds the 10 MB preview limit. Open it on eBay.');}
 if(!response.body)throw Error('eBay returned an empty document.');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES){await reader.cancel();throw Error('Document exceeds the 10 MB preview limit. Open it on eBay.');}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;
}
export async function resolveDisputeEvidence(db:any,c:any,evidenceId:unknown,fileId:unknown,getToken:()=>Promise<string>,apiBase:string,request:typeof fetch=fetch){
 const file=disputeFile(c,evidenceId,fileId);
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([c.ebay_return_id,evidenceId,fileId])))),b=>b.toString(16).padStart(2,'0')).join('');
 const directory=`payment-disputes/${c.id}`,path=`${directory}/${hash}`;
 const storage=db.storage.from(BUCKET),existing=checked(await storage.list(directory,{search:hash,limit:10}));
 const stored=existing?.find((f:any)=>f.name===hash);
 let mime=stored?.metadata?.mimetype;
 if(!stored){
  const token=await getToken(),query=new URLSearchParams({evidence_id:String(evidenceId),file_id:String(fileId)});
  // eBay can return the actual image MIME type; restricting Accept to octet-stream
  // is rejected by its gateway as upstream 406, wrapped in error 2003 / HTTP 500.
  const response=await request(`${apiBase}/sell/fulfillment/v1/payment_dispute/${encodeURIComponent(c.ebay_return_id)}/fetch_evidence_content?${query}`,{headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'*/*'},signal:AbortSignal.timeout(20000),redirect:'error'});
  const bytes=await boundedEvidence(response);mime=evidenceMime(bytes);
  const upload=await storage.upload(path,bytes,{contentType:mime,upsert:false});
  // Concurrent viewers may archive the same immutable eBay file simultaneously.
  if(upload.error&&!['409','Duplicate'].includes(String(upload.error.statusCode||upload.error.error)))throw upload.error;
 }
 const signed=checked(await storage.createSignedUrl(path,3600));
 return {url:signed.signedUrl,bucket:BUCKET,path,mime_type:mime||file.fileType,name:file.name||'Supporting document',archived:true};
}
