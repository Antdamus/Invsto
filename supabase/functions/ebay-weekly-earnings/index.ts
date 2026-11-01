import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
import {day,earningsScope,earningsWindow,earningRow} from './model.ts';

const origin='https://antdamus.github.io',dash=origin+'/Invsto/dashboard.html',uuid=/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i;
const env=(key:string)=>Deno.env.get(key)?.trim()||'';
const cors={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Cache-Control':'no-store'};
const json=(n:number,data:unknown)=>Response.json(data,{status:n,headers:cors});
const check=(r:any)=>{if(r.error)throw Error('Could not save earnings reconciliation');return r.data;};
const secret=()=>env('EBAY_CLIENT_SECRET')||env('EBAY_CERT_ID'),clientId=()=>env('EBAY_CLIENT_ID')||env('EBAY_APP_ID');
const enc=new TextEncoder();
async function cryptKey(){const hash=await crypto.subtle.digest('SHA-256',enc.encode('invsto/ebay/order-earnings/v1/'+secret()));return crypto.subtle.importKey('raw',hash,'AES-GCM',false,['encrypt','decrypt']);}
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
const decode=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function seal(text:string){const iv=crypto.getRandomValues(new Uint8Array(12));return encode(iv)+'.'+encode(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await cryptKey(),enc.encode(text))));}
async function unseal(text:string){const [iv,bytes]=text.split('.');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv)},await cryptKey(),decode(bytes)));}
async function token(value:string,exchange=false){
 const body:Record<string,string>=exchange?{grant_type:'authorization_code',code:value,redirect_uri:env('EBAY_OAUTH_RUNAME')}:{grant_type:'refresh_token',refresh_token:value,scope:earningsScope};
 const reply=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+btoa(clientId()+':'+secret()),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body),signal:AbortSignal.timeout(15000),redirect:'error'});
 const result=await reply.json();if(!reply.ok||!result.access_token||(exchange&&!result.refresh_token))throw Error('eBay earnings authorization required');return result;
}
async function page(access:string,w:ReturnType<typeof earningsWindow>,limit=200){
 const u=new URL('https://apiz.ebay.com/sell/finances/v1/order_earnings');u.search=new URLSearchParams({filter:`orderCreationDate:[${new Date(w.start).toISOString()}..${new Date(w.end-1).toISOString()}]`,limit:String(limit),offset:String(w.offset)}).toString();
 const r=await fetch(u,{headers:{Authorization:'Bearer '+access,Accept:'application/json','X-EBAY-C-MARKETPLACE-ID':'EBAY_US'},signal:AbortSignal.timeout(18000),redirect:'error'});
 if(!r.ok)throw Error('eBay earnings API '+r.status);const data=await r.json();
 if(!Number.isSafeInteger(data.total)||data.total<0||(data.offset??0)!==w.offset||!Array.isArray(data.orders??[])||(!data.orders?.length&&w.offset<data.total))throw Error('Incomplete eBay earnings page');return {...data,orders:data.orders||[]};
}
async function install(db:any,actor:string,grant:string,access:string){
 // A matching paid order binds this consent to the store already connected in Invsto.
 const now=Date.now(),sample=await page(access,{start:now-30*day,end:now,stop:0,offset:0},25);
 const ids=sample.orders.map((o:any)=>o.orderId);if(!ids.length||!check(await db.from('ebay_orders').select('order_number').in('order_number',ids).limit(1)).length)throw Error('Could not match this seller to OG Jewelers');
 check(await db.from('weekly_ebay_earnings_sync').update({credential:await seal(grant),actor,connected_at:new Date().toISOString(),lease:null,lease_until:null,claimed:false,next_at:new Date().toISOString(),last_error:null,stop_at:null,window_end:null,page_offset:0}).eq('singleton',true));
 check(await db.rpc('dispatch_weekly_ebay_earnings'));
}
async function worker(db:any,ticket:string){
 const c=check(await db.from('weekly_ebay_earnings_sync').update({claimed:true}).eq('lease',ticket).eq('claimed',false).gt('lease_until',new Date().toISOString()).select('*').maybeSingle());if(!c)return json(409,{error:'Expired worker lease'});
 try{
  const access=(await token(await unseal(c.credential))).access_token,start=Date.now();let cursor=c,done=false;
  for(let n=0;n<5&&!done&&Date.now()-start<32000;n++){
   const w=earningsWindow(cursor,start),p=await page(access,w),at=new Date().toISOString();
   const records=p.orders.map((o:any)=>earningRow(o,at)).filter(Boolean);
   if(records.length)check(await db.from('weekly_ebay_order_earnings').upsert(records,{onConflict:'order_number'}));
   const nextOffset=w.offset+p.orders.length,more=nextOffset<p.total;
   if(more&&(!p.orders.length||nextOffset>10000))throw Error('Incomplete eBay earnings page');
   done=!more&&w.start===w.stop;
   cursor={stop_at:done?null:new Date(w.stop).toISOString(),window_end:done?null:new Date(more?w.end:w.start).toISOString(),page_offset:more?nextOffset:0};
   const updated=check(await db.from('weekly_ebay_earnings_sync').update({...cursor,last_success:at,last_error:null}).eq('lease',ticket).select('singleton'));
   if(!updated.length)throw Error('Expired worker lease');
  }
  check(await db.from('weekly_ebay_earnings_sync').update({next_at:new Date(Date.now()+(done?6*3600000:0)).toISOString(),lease:null,lease_until:null,claimed:false}).eq('lease',ticket));return json(200,{ok:true});
 }catch(e){const reason=safe(e);check(await db.from('weekly_ebay_earnings_sync').update({last_error:reason,next_at:new Date(Date.now()+300000).toISOString(),lease:null,lease_until:null,claimed:false}).eq('lease',ticket));return json(502,{error:reason});}
}
const safe=(e:unknown)=>e instanceof Error&&/^(eBay earnings (API \d{3}|authorization required)|Could not match this seller to OG Jewelers|Incomplete eBay earnings page|Invalid earnings order identity)$/.test(e.message)?e.message:'Earnings sync could not finish';
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});if(req.method!=='POST')return json(405,{error:'POST required'});
 const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false}});
 try{
  const b=await req.json();if(b.ticket&&uuid.test(b.ticket))return await worker(db,b.ticket);
  if(b.action==='callback'){
   if(!uuid.test(b.state)||typeof b.code!=='string'||b.code.length>5000)return json(400,{error:'Invalid authorization'});
   const state=check(await db.from('weekly_ebay_earnings_auth').delete().eq('state',b.state).gt('expires_at',new Date().toISOString()).select('actor').maybeSingle());if(!state)return json(403,{error:'Authorization expired; reconnect in Invsto'});
   if(!check(await db.from('employees').select('user_id').eq('user_id',state.actor).eq('active',true).ilike('role','admin').maybeSingle()))return json(403,{error:'Active admin required'});
   const grant=await token(b.code,true);await install(db,state.actor,grant.refresh_token,grant.access_token);return json(200,{ok:true});
  }
  const jwt=req.headers.get('Authorization')?.replace(/^Bearer\s+/i,'');if(!jwt)return json(401,{error:'Sign in to Invsto'});
  const {data}=await db.auth.getUser(jwt);if(!data.user||!check(await db.from('employees').select('user_id').eq('user_id',data.user.id).eq('active',true).ilike('role','admin').maybeSingle()))return json(403,{error:'Active admin required'});
  if(b.action==='status'){const s=check(await db.from('weekly_ebay_earnings_sync').select('connected_at,last_success,last_error').eq('singleton',true).single());return json(200,s);}
  if(b.action!=='connect')return json(400,{error:'Unknown action'});
  const existing=env('EBAY_REFRESH_TOKEN');if(existing){let access;try{access=(await token(existing)).access_token;}catch{/* New consent may be needed. */}if(access){try{await install(db,data.user.id,existing,access);return json(200,{ok:true});}catch(e){if(!/^eBay earnings API (401|403)$/.test(safe(e)))throw e;}}}
  const s=check(await db.from('weekly_ebay_earnings_auth').insert({actor:data.user.id}).select('state').single());
  const auth=new URL('https://auth.ebay.com/oauth2/authorize');auth.search=new URLSearchParams({client_id:clientId(),response_type:'code',redirect_uri:env('EBAY_OAUTH_RUNAME'),scope:earningsScope,state:'earn-'+s.state}).toString();return json(200,{url:auth.href});
 }catch(e){return json(502,{error:safe(e)});}
});
