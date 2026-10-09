import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
import {fetchCertificate,cglUrl} from './certificate-file.ts';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{...cors,'Content-Type':'application/json'}});
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
Deno.serve(async request=>{
 if(request.method==='OPTIONS')return new Response('ok',{headers:cors});
 if(request.method!=='POST')return json({error:'POST required'},405);
 try{
  const authorization=request.headers.get('Authorization')||'';
  if(!authorization.startsWith('Bearer '))return json({error:'Sign in to save a certificate.'},401);
  const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:authorization}},auth:{persistSession:false}});
  const {data:auth,error:authError}=await client.auth.getUser();if(authError||!auth.user)return json({error:'Sign in to save a certificate.'},401);
  const access=await Promise.all([client.rpc('can_manage_inventory'),client.rpc('can_access_post_order_issues')]);
  if(!access.some(r=>!r.error&&r.data===true))return json({error:'Staff access required.'},403);
  const body=await request.json();
  if(!uuid(body.id)||!uuid(body.line_id)||typeof body.url!=='string')return json({error:'Choose the order item and certificate link.'},400);
  const url=cglUrl(body.url).href;
  const {data:line,error:lineError}=await client.from('ebay_order_lines').select('id').eq('id',body.line_id).maybeSingle();
  if(lineError||!line)return json({error:'Order item not found.'},404);
  const {data:existing,error:existingError}=await client.from('ebay_order_line_certificates').select('*').eq('id',body.id).maybeSingle();if(existingError)throw existingError;
  if(existing){if(existing.order_line_id!==body.line_id||existing.created_by!==auth.user.id)return json({error:'Certificate request does not match this item.'},409);return json({certificate:existing});}
  const file=await fetchCertificate(url),path=`certificates/${body.line_id}/${body.id}/${file.hash}.${file.extension}`;
  const {error:uploadError}=await client.storage.from('order-evidence-photos').upload(path,file.bytes,{contentType:file.mime,upsert:false});
  if(uploadError&&String((uploadError as {statusCode?:string}).statusCode)!=='409'&&!/already exists|duplicate/i.test(uploadError.message))throw uploadError;
  const {data,error}=await client.rpc('save_order_line_certificate',{_id:body.id,_line_id:body.line_id,_qr_text:body.qr_text||body.url,_url:url,
   _report_number:body.report_number||null,_watch_serial:body.watch_serial||null,
   _attachments:[{bucket:'order-evidence-photos',path,mime_type:file.mime,size:file.bytes.length,label:'CGL certificate',sha256:file.hash,source_url:file.url}]});
  if(error)throw error;return json({certificate:data});
 }catch(error){return json({error:error instanceof Error?error.message:'Could not save a certificate copy. Add a PDF or photo and retry.'},400);}
});
