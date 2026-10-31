import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
import {client,mapOrder,seal,unseal,WhatnotError} from './whatnot.mjs';
const CORS={'Access-Control-Allow-Origin':'https://antdamus.github.io','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin','Cache-Control':'no-store'};
const env=(n:string)=>{const v=Deno.env.get(n);if(!v)throw new WhatnotError('Whatnot server setup is incomplete.');return v;};
const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers:{...CORS,'Content-Type':'application/json'}});
const check=(r:any)=>{if(r.error)throw new WhatnotError('Could not save Whatnot progress. Retry shortly.');return r.data;};
const message=(e:unknown)=>e instanceof WhatnotError?e.message:'Whatnot sync could not finish. It will retry without skipping orders.';

async function worker(db:any,token:string){
 const c=check(await db.rpc('claim_whatnot_worker',{_token:token}));if(!c)return reply(409,{error:'Sync request expired or already running.'});
 try{
  if(!check(await db.rpc('whatnot_api_authorizer_allowed',{_user:c.authorized_by})))throw new WhatnotError('An active administrator must reconnect Whatnot.');
  const api=client(await unseal(c.credentials,env('WHATNOT_TOKEN_ENCRYPTION_KEY')));
  const shipments=new Map(),shows=new Map();let saved=0;
  async function importOrder(order:any){
   const items=await api.items(order.id);
   for(const item of items)if(item.shipment_id&&!shipments.has(item.shipment_id))shipments.set(item.shipment_id,await api.read(`/shipments/${item.shipment_id}`));
   if(order.show_id&&!shows.has(order.show_id))shows.set(order.show_id,await api.read(`/shows/${order.show_id}`));
   const record=mapOrder(order,items,shipments,shows.get(order.show_id));
   check(await db.rpc('import_whatnot_worker_order',{_token:token,_record:record}));saved++;
  }
  const p=await api.page('/orders',c.full_in_progress?c.page_cursor:null,30);
  for(const o of p.data)await importOrder(o);
  // While a backfill is running, periodically revisit the newest orders too.
  if(c.full_in_progress&&c.page_cursor){const recent=await api.page('/orders',null,5);for(const o of recent.data)if(!p.data.some((x:any)=>x.id===o.id))await importOrder(o);}
  if(!c.full_in_progress){
   // Shipment changes can occur without changing an order's list position.
   // Revisit all open work in oldest-sync order; full history is reconciled every six hours.
   const pending=check(await db.from('whatnot_order_lines').select('order_id,synced_at').eq('work_state','pending').order('synced_at').limit(50));
   const ids=[...new Set(pending.map((l:any)=>l.order_id))].filter(id=>!p.data.some((x:any)=>x.id===id)).slice(0,20);
   for(const id of ids)await importOrder(await api.read(`/orders/${id}`));
  }
  const more=c.full_in_progress&&Boolean(p.next_cursor);
  const changes=c.full_in_progress?{page_cursor:more?p.next_cursor:null,full_in_progress:more,orders_processed:c.orders_processed+p.data.length,...(!more?{last_full_sync_at:new Date().toISOString()}:{} )}:{};
  check(await db.from('whatnot_api_connection').update({...changes,last_synced_at:new Date().toISOString(),last_error:null,next_sync_at:new Date(Date.now()+(more?0:300000)).toISOString(),dispatch_token:null,lease_until:null,claimed:false}).eq('singleton',true).eq('dispatch_token',token));
  return reply(200,{ok:true,orders_read:saved,more});
 }catch(e){const error=message(e);await db.from('whatnot_api_connection').update({last_error:error,next_sync_at:new Date(Date.now()+300000).toISOString(),dispatch_token:null,lease_until:null,claimed:false}).eq('singleton',true).eq('dispatch_token',token);return reply(502,{error});}
}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
 if(req.method!=='POST')return reply(405,{error:'Method not allowed'});
 try{
  const text=await req.text();if(text.length>8192)return reply(413,{error:'Request too large'});const body=JSON.parse(text);
  const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
  if(body.workerToken){if(!/^[a-f0-9-]{36}$/.test(body.workerToken))return reply(401,{error:'Invalid sync request'});return await worker(db,body.workerToken);}
  const authorization=req.headers.get('Authorization')||'';
  const userDb=createClient(env('SUPABASE_URL'),env('SUPABASE_ANON_KEY'),{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
  const auth=await userDb.auth.getUser();if(auth.error||!auth.data.user)return reply(401,{error:'Sign in to Invsto.'});
  if(check(await userDb.rpc('can_manage_inventory'))!==true)return reply(403,{error:'Inventory staff access required.'});
  const admin=check(await db.rpc('whatnot_api_authorizer_allowed',{_user:auth.data.user.id}))===true;
  if(body.action==='status'){
   const c=check(await db.from('whatnot_api_connection').select('seller_name,seller_id,connected_at,enabled,expires_at,last_synced_at,last_full_sync_at,last_error,full_in_progress,orders_processed,lease_until').eq('singleton',true).maybeSingle());
   return reply(200,{admin,configured:Boolean(Deno.env.get('WHATNOT_TOKEN_ENCRYPTION_KEY')),connection:c});
  }
  if(body.action==='connect'){
   if(!admin)return reply(403,{error:'An active administrator must connect Whatnot.'});
   const api=client(body.token),seller=await api.read('/users/me');
   if(seller.username?.toLowerCase()!=='ogjewelers')throw new WhatnotError('Use a token from the ogjewelers Whatnot account.');
   await api.page('/orders',null,1);
   const expires=body.expiresAt?new Date(body.expiresAt):null;if(expires&&(!Number.isFinite(+expires)||+expires<Date.now()))throw new WhatnotError('Choose the token’s actual future expiration date.');
   check(await db.rpc('install_whatnot_connection',{_seller:seller.id,_name:seller.username,_credentials:await seal(body.token,env('WHATNOT_TOKEN_ENCRYPTION_KEY')),_actor:auth.data.user.id,_expires:expires?.toISOString()||null}));
   check(await db.rpc('dispatch_whatnot_worker'));return reply(200,{ok:true,seller:seller.username});
  }
  if(body.action==='sync'||body.action==='full_sync'){
   if(body.action==='full_sync'&&!admin)return reply(403,{error:'Administrator access required.'});
   const changes=body.action==='full_sync'?{full_in_progress:true,page_cursor:null,orders_processed:0}:{};
   const q=db.from('whatnot_api_connection').update({...changes,next_sync_at:new Date().toISOString()}).eq('singleton',true).eq('enabled',true);
   if(body.action==='full_sync')q.or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`);
   check(await q);check(await db.rpc('dispatch_whatnot_worker'));return reply(202,{ok:true});
  }
  if(body.action==='pause'||body.action==='resume'){
   if(!admin)return reply(403,{error:'Administrator access required.'});
   check(await db.from('whatnot_api_connection').update({enabled:body.action==='resume',next_sync_at:new Date().toISOString()}).eq('singleton',true));
   if(body.action==='resume')check(await db.rpc('dispatch_whatnot_worker'));return reply(200,{ok:true});
  }
  return reply(400,{error:'Unknown action.'});
 }catch(e){return reply(400,{error:message(e)});}
});
