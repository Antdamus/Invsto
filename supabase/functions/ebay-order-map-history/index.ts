import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const env=(name:string)=>Deno.env.get(name)||'';
const url=env('SUPABASE_URL'), key=env('SUPABASE_SERVICE_ROLE_KEY');
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json'}});
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const checked=(r:any)=>{if(r.error)throw r.error;return r.data;};
async function authorized(req:Request){
  const auth=req.headers.get('Authorization')||'';
  if(key&&auth===`Bearer ${key}`)return true;
  if(!auth.startsWith('Bearer '))return false;
  const user=await db.auth.getUser(auth.slice(7));if(user.error||!user.data.user)return false;
  const staff=createClient(url,env('SUPABASE_ANON_KEY'),{global:{headers:{Authorization:auth}},auth:{persistSession:false,autoRefreshToken:false}});
  const permission=await staff.rpc('can_manage_inventory');return !permission.error&&permission.data===true;
}
async function ebayToken(){
  const id=env('EBAY_CLIENT_ID')||env('EBAY_APP_ID'),secret=env('EBAY_CLIENT_SECRET')||env('EBAY_CERT_ID');
  const base=env('EBAY_ENV')==='sandbox'?'https://api.sandbox.ebay.com':'https://api.ebay.com';
  const response=await fetch(`${base}/identity/v1/oauth2/token`,{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:`Basic ${btoa(`${id}:${secret}`)}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:env('EBAY_REFRESH_TOKEN'),scope:'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'})});
  if(!response.ok)throw Error(`eBay authorization failed (${response.status}).`);
  const data=await response.json();if(!data.access_token)throw Error('eBay authorization is unavailable.');return {base,token:data.access_token};
}
Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return reply(405,{error:'POST required'});
  try{
    if(!await authorized(req))return reply(401,{error:'Sign in with inventory staff access.'});
    const body=await req.json().catch(()=>({}));
    let run:any;
    if(body.runId){run=checked(await db.from('ebay_order_map_capture_runs').select('*').eq('id',body.runId).single());}
    else{
      const earliest=checked(await db.rpc('ebay_order_map_earliest_pending'));
      if(!earliest)return reply(200,{complete:true,orders:0,message:'No dated pending orders.'});
      const recent=checked(await db.from('ebay_order_map_capture_runs').select('*').lte('since_at',earliest).order('created_at',{ascending:false}).limit(1))?.[0];
      if(recent&&Date.now()-Date.parse(recent.updated_at)<15*60*1000)run=recent;
      else run=checked(await db.from('ebay_order_map_capture_runs').insert({since_at:earliest,window_start:earliest}).select().single());
    }
    if(run.status==='complete')return reply(200,{complete:true,runId:run.id,orders:run.order_count,since:run.since_at,until:run.until_at});
    const start=Date.parse(run.window_start),end=Math.min(start+30*86400000,Date.parse(run.until_at));
    const {base,token}=await ebayToken();
    // No fulfillment filter: include paid, unpaid, shipped and canceled orders in history.
    const params=new URLSearchParams({limit:'200',offset:String(run.page_offset),filter:`creationdate:[${new Date(start).toISOString()}..${new Date(end).toISOString()}]`});
    const response=await fetch(`${base}/sell/fulfillment/v1/order?${params}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(25000)});
    if(!response.ok)throw Error(`eBay history request failed (${response.status}). Retry to resume.`);
    const payload=await response.json(),orders=payload.orders||[];
    const rows=orders.map((o:any)=>({order_number:o.orderId||o.legacyOrderId,buyer_username:o.buyer?.username||'',purchased_at:o.creationDate,captured_at:new Date().toISOString(),evidence:{payment:o.orderPaymentStatus,fulfillment:o.orderFulfillmentStatus,cancellation:o.cancelStatus?.cancelState,lines:(o.lineItems||[]).map((l:any)=>({lineItemId:l.lineItemId,itemNumber:l.legacyItemId,title:l.title,quantity:l.quantity,total:l.lineItemCost,properties:l.properties||null}))}}));
    if(rows.length)checked(await db.from('ebay_order_map_history').upsert(rows,{onConflict:'order_number'}));
    const more=Boolean(payload.next),complete=!more&&end>=Date.parse(run.until_at);
    const next={page_offset:more?run.page_offset+orders.length:0,window_start:more?run.window_start:new Date(end+1).toISOString(),order_count:run.order_count+orders.length,status:complete?'complete':'running',updated_at:new Date().toISOString()};
    if(more&&!orders.length)throw Error('eBay returned an empty history page before completion. Retry to resume.');
    checked(await db.from('ebay_order_map_capture_runs').update(next).eq('id',run.id).eq('page_offset',run.page_offset).eq('window_start',run.window_start));
    return reply(200,{complete,runId:run.id,orders:next.order_count,since:run.since_at,until:run.until_at});
  }catch(e){console.error('Order-map history:',e instanceof Error?e.message:'Request failed');return reply(500,{error:e instanceof Error?e.message:'History capture failed; retry to resume.'});}
});
