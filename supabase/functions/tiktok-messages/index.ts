import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';
import {unseal,TikTokError} from '../tiktok-order-sync/tiktok.ts';
import {CHAT_SCOPE,CONVERSATIONS_PATH,chatClient,page} from './provider.ts';

const CORS={'Access-Control-Allow-Origin':'https://antdamus.github.io','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Cache-Control':'no-store','Vary':'Origin'};
const env=(name:string)=>{const value=Deno.env.get(name);if(!value)throw Error('TikTok messaging is not configured on the server.');return value;};
const json=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers:{...CORS,'Content-Type':'application/json'}});
const check=(result:any)=>{if(result.error)throw Error('TikTok messaging data could not be loaded or saved. Please refresh.');return result.data;};
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const safe=(e:unknown)=>e instanceof TikTokError?e.message:e instanceof Error&&!/https?:|TTP_|token=|secret=/i.test(e.message)?e.message.slice(0,300):'TikTok messaging could not finish. Please retry.';
class ChatAccessError extends Error { permission:boolean; constructor(message:string,permission=false){super(message);this.permission=permission;} }
async function connection(db:any,requireAccess=true){
 const c=check(await db.from('tiktok_api_connection').select('*').eq('singleton',true).maybeSingle());
 if(!c)throw new ChatAccessError('Connect the TikTok shop from Pending TikTok Orders first.');
 if(!check(await db.rpc('tiktok_api_authorizer_allowed',{_user:c.authorized_by})))throw new ChatAccessError('An active administrator must reconnect TikTok.');
 const tokens=await unseal(c.credentials,env('TIKTOK_TOKEN_ENCRYPTION_KEY'));
 const allowed=tokens.granted_scopes?.includes(CHAT_SCOPE)===true;
 if(requireAccess&&!allowed)throw new ChatAccessError('TikTok buyer-chat permission is not enabled. An administrator must enable Customer Service for the app and reconnect the shop.',true);
 if(requireAccess&&tokens.access_token_expire_in<=Date.now()/1000){
  if(c.enabled){check(await db.from('tiktok_api_connection').update({next_sync_at:new Date().toISOString()}).eq('singleton',true));check(await db.rpc('dispatch_tiktok_api_worker'));}
  throw new ChatAccessError(c.enabled?'TikTok is renewing its connection. Try again shortly.':'Reconnect TikTok or resume order sync to renew the connection.');
 }
 return {c,tokens,allowed,api:chatClient(env('TIKTOK_APP_KEY'),env('TIKTOK_APP_SECRET'))};
}
async function worker(db:any,token:string){
 const s=check(await db.rpc('claim_tiktok_chat_worker',{_token:token}));
 if(!s?.singleton)return json(409,{error:'Chat sync is already running or this request expired.'});
 try{
  const {c,tokens,api}=await connection(db);
  const query:Record<string,string>={shop_cipher:c.shop_cipher,page_size:'20',locale:'en'};if(s.page_token)query.page_token=s.page_token;
  const result=page(await api.read(CONVERSATIONS_PATH,tokens.access_token,query),'conversations',s.page_token);
  check(await db.rpc('save_tiktok_chat_page',{_token:token,_shop:c.shop_id,_rows:result.rows,_next:result.next_page_token}));
  // Continue a large inbox promptly; the minute scheduler also recovers missed dispatches.
  if(result.next_page_token)await db.rpc('dispatch_tiktok_chat_worker');
  return json(200,{ok:true,conversations:result.rows.length,more:Boolean(result.next_page_token)});
 }catch(e){
  const permission=e instanceof ChatAccessError&&e.permission;
  await db.from('tiktok_chat_sync_state').update({last_error:safe(e),needs_permission:permission,next_sync_at:new Date(Date.now()+(permission?3600000:300000)).toISOString(),dispatch_token:null,lease_until:null,claimed:false}).eq('singleton',true).eq('dispatch_token',token);
  return json(502,{error:safe(e),needs_permission:permission});
 }
}
async function status(db:any){
 const s=check(await db.from('tiktok_chat_sync_state').select('enabled,last_synced_at,last_error,needs_permission,lease_until,page_token').eq('singleton',true).single());
 try{const {c,allowed}=await connection(db,false);return {...s,page_token:undefined,syncing:Boolean(s.enabled&&(s.lease_until&&Date.parse(s.lease_until)>Date.now()||s.page_token&&!s.last_error)),connected:true,shop_name:c.shop_name,chat_authorized:allowed,needs_permission:!allowed};}
 catch(e){return {...s,page_token:undefined,syncing:false,connected:false,chat_authorized:false,last_error:safe(e)};}
}
async function ordersForBuyer(db:any,buyer:string){
 const orders=check(await db.from('tiktok_orders').select('id,order_number,buyer_username,buyer_nickname,recipient_name,stage,marketplace_status,created_time,order_amount,ship_by_date').eq('api_buyer_id',buyer).order('created_time',{ascending:false}).limit(300));
 if(!orders.length)return [];
 const lines=check(await db.from('tiktok_order_lines').select('id,order_id,title,quantity,line_amount,tracking_number').in('order_id',orders.map((o:any)=>o.id)));
 return orders.map((o:any)=>({...o,lines:lines.filter((l:any)=>l.order_id===o.id)}));
}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
 if(req.method!=='POST')return json(405,{error:'Method not allowed'});
 try{
  const bodyText=await req.text();if(bodyText.length>8192)return json(413,{error:'Request too large'});const body=JSON.parse(bodyText);
  const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
  if(body.workerToken){if(!uuid(body.workerToken))return json(401,{error:'Invalid sync request'});return await worker(db,body.workerToken);}
  const authorization=req.headers.get('Authorization')||'';if(!authorization.startsWith('Bearer '))return json(401,{error:'Sign in to Invsto.'});
  const staff=createClient(env('SUPABASE_URL'),env('SUPABASE_ANON_KEY'),{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
  const auth=await staff.auth.getUser();if(auth.error||!auth.data.user)return json(401,{error:'Sign in to Invsto.'});
  if(check(await staff.rpc('can_access_tiktok_messages'))!==true)return json(403,{error:'Messaging access is required. Ask an administrator to enable Email Triage access for your account.'});
  if(body.action==='status')return json(200,await status(db));
  if(body.action==='refresh'){
   await connection(db);check(await db.from('tiktok_chat_sync_state').update({next_sync_at:new Date().toISOString()}).eq('singleton',true));check(await db.rpc('dispatch_tiktok_chat_worker'));return json(202,{queued:true});
  }
  if(body.action==='inbox'){
   const term=String(body.search||'').slice(0,200),filter=['open','waiting','done','unread'].includes(body.filter)?body.filter:'all',offset=Number.isInteger(body.offset)&&body.offset>=0&&body.offset<=100000?body.offset:0;
   const conversations=check(await staff.rpc('list_tiktok_chats',{_search:term,_filter:filter,_offset:offset}));
   return json(200,{conversations,more:conversations.length===100,counts:check(await staff.rpc('count_tiktok_chats')),status:await status(db)});
  }
  if(body.action==='order'){
   if(!uuid(body.orderId))return json(400,{error:'Invalid order link.'});
   const order=check(await db.from('tiktok_orders').select('id,order_number,buyer_username,buyer_nickname,recipient_name,api_buyer_id').eq('id',body.orderId).maybeSingle());
   if(!order)return json(404,{error:'This TikTok order was not found.'});
   const conversations=order.api_buyer_id?check(await db.from('tiktok_chat_conversations').select('id').eq('buyer_id',order.api_buyer_id)):[];
   return json(200,{order,conversations});
  }
  if(body.action==='conversation'){
   if(!uuid(body.id)||body.cursor!=null&&(typeof body.cursor!=='string'||body.cursor.length>4096))return json(400,{error:'Invalid conversation request.'});
   const chat=check(await db.from('tiktok_chat_conversations').select('*').eq('id',body.id).maybeSingle());if(!chat)return json(404,{error:'Conversation not found.'});
   const notes=check(await db.from('tiktok_chat_notes').select('*').eq('conversation_id',chat.id).order('created_at',{ascending:true}).limit(500));
   const orders=await ordersForBuyer(db,chat.buyer_id);
   try{
    const {c,tokens,api}=await connection(db);if(c.shop_id!==chat.shop_id)return json(409,{error:'This conversation belongs to a different shop.'});
    const query:Record<string,string>={shop_cipher:c.shop_cipher,page_size:'10',locale:'en',sort_order:'DESC',sort_field:'index',need_data:'true'};if(body.cursor)query.page_token=body.cursor;
    const result=page(await api.read(`${CONVERSATIONS_PATH}/${chat.conversation_id}/messages`,tokens.access_token,query),'messages',body.cursor);
    return json(200,{conversation:chat,notes,orders,messages:result.rows,next_page_token:result.next_page_token});
   }catch(e){return json(200,{conversation:chat,notes,orders,messages:[],next_page_token:null,history_error:safe(e)});}
  }
  return json(400,{error:'Unknown messaging action.'});
 }catch(e){return json(400,{error:safe(e),needs_permission:e instanceof ChatAccessError&&e.permission});}
});
