import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
const env=(name:string)=>Deno.env.get(name)||'';
const key=env('SUPABASE_SERVICE_ROLE_KEY');
const reply=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
Deno.serve(async(req:Request)=>{
 if(req.method!=='POST')return reply(405,{error:'POST required'});
 if(!key||req.headers.get('Authorization')!==`Bearer ${key}`)return reply(403,{error:'Internal reconciliation access required'});
 try{
  const b=await req.json(),from=Date.parse(b.from),to=Date.parse(b.to),offset=Number(b.offset||0);
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>7*86400000||from<Date.now()-720*86400000||to>Date.now()+60000||!Number.isInteger(offset)||offset<0||offset>10000)throw Error('Choose a valid past range of at most seven days and a valid page offset');
  const base=env('EBAY_ENV')==='sandbox'?'https://api.sandbox.ebay.com':'https://api.ebay.com';
  const tokenResponse=await fetch(base+'/identity/v1/oauth2/token',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:'Basic '+btoa((env('EBAY_CLIENT_ID')||env('EBAY_APP_ID'))+':'+(env('EBAY_CLIENT_SECRET')||env('EBAY_CERT_ID'))),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:env('EBAY_REFRESH_TOKEN'),scope:'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'})});
  if(!tokenResponse.ok)throw Error('eBay authorization failed ('+tokenResponse.status+')');
  const token=await tokenResponse.json();if(!token.access_token)throw Error('eBay access unavailable');
  const params=new URLSearchParams({limit:'25',offset:String(offset),filter:`creationdate:[${new Date(from).toISOString()}..${new Date(to).toISOString()}]`});
  const response=await fetch(base+'/sell/fulfillment/v1/order?'+params,{headers:{Authorization:'Bearer '+token.access_token},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('eBay order history failed ('+response.status+')');
  const payload=await response.json(),orders=payload.orders||[],total=payload.total;
  if(!Array.isArray(orders)||orders.length>100||!Number.isInteger(total)||total<0||orders.some((o:any)=>!o.orderId||!Number.isFinite(Date.parse(o.creationDate))||Date.parse(o.creationDate)<from||Date.parse(o.creationDate)>to)||new Set(orders.map((o:any)=>o.orderId)).size!==orders.length)throw Error('Incomplete or invalid eBay history page');
  const more=Boolean(payload.next);
  if(more&&(!orders.length||offset+orders.length>=total)||!more&&offset+orders.length<total)throw Error('Incomplete eBay pagination');
  const db=createClient(env('SUPABASE_URL'),key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await db.rpc('reconcile_ebay_show_orders',{_orders:orders,_dry_run:b.dryRun!==false});
  if(error)throw Error(error.message);
  return reply(200,{ok:true,from:new Date(from).toISOString(),to:new Date(to).toISOString(),offset,scanned:orders.length,total,nextOffset:more?offset+orders.length:null,...data});
 }catch(e){return reply(500,{ok:false,error:e instanceof Error?e.message:'History reconciliation failed'});}
});
