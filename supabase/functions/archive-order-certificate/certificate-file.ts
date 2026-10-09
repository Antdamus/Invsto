// Bounded provider-only downloads. Inspect document links; never execute HTML.
export const MAX_CERTIFICATE_BYTES=10*1024*1024;
export function cglUrl(value:string,base?:string):URL {
 const url=new URL(value,base);if(url.protocol==='http:')url.protocol='https:';
 if(url.protocol!=='https:'||!['cgl-labs.com','www.cgl-labs.com','miami.cgl-labs.com'].includes(url.hostname)||url.username||url.password||url.port||value.length>2048)
  throw Error('Add a PDF or photo copy for this certificate website.');
 return url;
}
export function certificateType(bytes:Uint8Array):{mime:string;extension:string}|null {
 const text=(a:number,b:number)=>new TextDecoder().decode(bytes.slice(a,b));
 if(text(0,5)==='%PDF-')return {mime:'application/pdf',extension:'pdf'};
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {mime:'image/jpeg',extension:'jpg'};
 if([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return {mime:'image/png',extension:'png'};
 if(text(0,4)==='RIFF'&&text(8,12)==='WEBP')return {mime:'image/webp',extension:'webp'};
 return null;
}
export function reportDocument(html:string,base:string):string {
 const links=new Set<string>();
 for(const tag of html.matchAll(/<(?:iframe|embed|object|a)\b[^>]*>/gi)){
  const match=tag[0].match(/\b(?:src|data|href)\s*=\s*["']([^"']+)["']/i);if(!match)continue;
  try{const url=cglUrl(match[1].replace(/&amp;/gi,'&').replace(/&#0*38;/g,'&'),base);
   if(/\.pdf(?:$|[_.?])/i.test(url.pathname+url.search))links.add(url.href);
  }catch{/* Unrelated sites cannot supply an automatic certificate copy. */}
 }
 if(links.size!==1)throw Error('This page does not provide one downloadable certificate. Add its PDF or a clear photo.');
 return [...links][0];
}
export async function fetchCertificate(value:string,fetcher:typeof fetch=fetch){
 const signal=AbortSignal.timeout(18000);
 async function read(input:string){
  let url=cglUrl(input);
  for(let redirect=0;redirect<4;redirect++){
   const response=await fetcher(url.href,{redirect:'manual',signal,headers:{Accept:'application/pdf,image/*,text/html;q=0.8'}});
   if([301,302,303,307,308].includes(response.status)){
    const location=response.headers.get('location');await response.body?.cancel();
    if(!location)throw Error('Certificate redirect is missing. Add a PDF or photo instead.');
    url=cglUrl(location,url.href);continue;
   }
   if(!response.ok){await response.body?.cancel();throw Error('CGL could not provide this certificate. Check the link or upload a copy.');}
   if(Number(response.headers.get('content-length'))>MAX_CERTIFICATE_BYTES){await response.body?.cancel();throw Error('Certificate copies must be 10 MB or smaller.');}
   const reader=response.body?.getReader();if(!reader)throw Error('The certificate response was empty.');
   const chunks:Uint8Array[]=[];let size=0;
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_CERTIFICATE_BYTES){await reader.cancel();throw Error('Certificate copies must be 10 MB or smaller.');}chunks.push(value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   return {bytes,url:url.href};
  }
  throw Error('Too many certificate redirects. Upload the PDF or photo instead.');
 }
 let file=await read(cglUrl(value).href),type=certificateType(file.bytes);
 if(!type){file=await read(reportDocument(new TextDecoder().decode(file.bytes),file.url));type=certificateType(file.bytes);}
 if(!type)throw Error('The download is not a PDF or certificate photo. Add a copy manually.');
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',file.bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
 return {...file,...type,hash};
}
