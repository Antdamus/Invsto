import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cglUrl,reportDocument,fetchCertificate,MAX_CERTIFICATE_BYTES} from '../supabase/functions/archive-order-certificate/certificate-file.ts';
const qr='http://www.cgl-labs.com/27-qr7732';
test('the supplied CGL QR format resolves its embedded certificate PDF once',async()=>{
 const calls=[],path='office/photos-miami/certificat_7732.pdf_2026100913094314849006661587617797';
 const file=await fetchCertificate(qr,async(url,options)=>{calls.push(url);assert.equal(options.redirect,'manual');
  return calls.length===1?new Response(`<object data="${path}"><embed src="${path}"></object><a href="https://miami.cgl-labs.com/certificat-2778747053007732.html">Download</a>`):new Response('%PDF-1.4\ncertificate');});
 assert.equal(calls.length,2);assert.equal(calls[1],'https://www.cgl-labs.com/'+path);
 assert.equal(file.mime,'application/pdf');assert.equal(file.hash.length,64);
});
test('provider imports cannot follow external, local, authenticated or non-HTTPS targets',async()=>{
 for(const value of ['http://localhost/cert','https://127.0.0.1/a','https://cgl-labs.com.evil.test/a','https://www.cgl-labs.com@evil.test/a','https://user:pass@www.cgl-labs.com/a','file:///tmp/a','https://www.cgl-labs.com:8080/a'])assert.throws(()=>cglUrl(value));
 await assert.rejects(fetchCertificate(qr,async()=>new Response(null,{status:302,headers:{location:'http://169.254.169.254/latest/'}})),/Add a PDF/);
 assert.throws(()=>reportDocument('<object data="https://evil.test/cert.pdf">',qr),/one downloadable/);
 assert.throws(()=>reportDocument('<a href="a.pdf">A</a><a href="b.pdf">B</a>',qr),/one downloadable/);
});
test('file size, type, failed provider and redirect bounds are enforced',async()=>{
 await assert.rejects(fetchCertificate(qr,async()=>new Response('%PDF-x',{headers:{'content-length':String(MAX_CERTIFICATE_BYTES+1)}})),/10 MB/);
 await assert.rejects(fetchCertificate(qr,async()=>new Response(new Uint8Array(MAX_CERTIFICATE_BYTES+1))),/10 MB/);
 await assert.rejects(fetchCertificate(qr,async()=>new Response('Not found',{status:404})),/could not provide/);
 await assert.rejects(fetchCertificate(qr,async()=>new Response('<script>alert(1)</script>',{headers:{'content-type':'application/pdf'}})),/one downloadable/);
 let calls=0;await assert.rejects(fetchCertificate(qr,async()=>{calls++;return new Response(null,{status:302,headers:{location:'/again'}});}),/Too many/);assert.equal(calls,4);
});
