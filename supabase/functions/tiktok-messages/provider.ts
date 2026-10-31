import {sign, TikTokError} from '../tiktok-order-sync/tiktok.ts';

export const CHAT_SCOPE = 'seller.customer_service';
export const CONVERSATIONS_PATH = '/customer_service/202309/conversations';
export const SEND_PATH = '/customer_service/202606/conversations';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const validId = (value: unknown) => typeof value === 'string' && /^\d{10,30}$/.test(value);
const id = (value: unknown) => { if (!validId(value)) throw Error('TikTok returned an invalid chat identifier.'); return value as string; };
const text = (value: unknown, limit = 2000) => typeof value === 'string' ? value.slice(0,limit) : '';
const instant = (value: unknown) => { if (!Number.isSafeInteger(value) || Number(value)<1 || Number(value)>4102444800) throw Error('TikTok returned an invalid message time.'); return new Date(Number(value)*1000).toISOString(); };
const mediaUrl = (value: unknown) => { try { const url=new URL(String(value)); return url.protocol==='https:'&&!url.username&&!url.password ? url.href : null; } catch { return null; } };
export function message(row: any) {
  if (!row || row.is_visible === false) return null;
  let content: any = {}; try { content=JSON.parse(row.content || '{}'); } catch { /* Unsupported content stays explicitly unavailable. */ }
  if (!content || typeof content!=='object' || Array.isArray(content)) content={};
  const role=['BUYER','SHOP','CUSTOMER_SERVICE','SYSTEM','ROBOT'].includes(row.sender?.role) ? row.sender.role : 'UNKNOWN';
  const type=text(row.type,80) || 'OTHER';
  return {id:id(row.id),index:typeof row.index==='string'&&/^\d{1,30}$/.test(row.index)?row.index:null,sent_at:instant(row.create_time),role,sender:text(row.sender?.nickname,240),type,
    text:text(content.content,20000),url:['IMAGE','VIDEO'].includes(type)?mediaUrl(content.url):null,cover:type==='VIDEO'?mediaUrl(content.cover):null,
    order_id:validId(content.order_id)?content.order_id:null,sku_id:validId(content.sku_id)?content.sku_id:null,product_id:validId(content.product_id)?content.product_id:null};
}
export function conversation(row: any) {
  if (!row || !Array.isArray(row.participants)) throw Error('TikTok returned an incomplete conversation.');
  const buyers=row.participants.filter((p:any)=>p.role==='BUYER');
  if (buyers.length!==1) throw Error('TikTok conversation buyer could not be identified safely.');
  const buyer=buyers[0], latest=message(row.latest_message);
  return {conversation_id:id(row.id),buyer_id:id(buyer.user_id),buyer_name:text(buyer.nickname,240),
    latest_message:latest,latest_message_id:latest?.id || null,latest_message_at:latest?.sent_at || null,
    latest_preview:latest ? latest.text || ({IMAGE:'Photo',VIDEO:'Video',ORDER_CARD:'Order',RETURN_REFUND_CARD:'Return / refund'} as Record<string,string>)[latest.type] || 'TikTok message' : '',
    latest_sender_role:latest?.role || null,unread_count:Number.isSafeInteger(row.unread_count)&&row.unread_count>=0?row.unread_count:0,can_send_message:row.can_send_message===true};
}
export function page(data:any, kind:'conversations'|'messages', previousCursor?:string) {
  if (!data || typeof data!=='object' || Array.isArray(data)) throw Error('TikTok returned an invalid chat page.');
  const cursor=data.next_page_token;
  if (cursor!=null && (typeof cursor!=='string'||cursor.length>4096) || cursor && cursor===previousCursor) throw Error('TikTok chat pagination could not continue safely.');
  if (!Array.isArray(data[kind]) && !(data[kind]==null&&!cursor)) throw Error('TikTok returned an invalid chat list.');
  const rows=(data[kind]||[]).map(kind==='conversations'?conversation:message).filter(Boolean);
  return {rows,next_page_token:cursor||null};
}
export function chatClient(appKey:string, secret:string, request:typeof fetch=fetch) {
  async function call(path:string, token:string, query:Record<string,string>, method:string, body?:Record<string,unknown>|FormData) {
    const params={...query,app_key:appKey,timestamp:String(Math.floor(Date.now()/1000))};
    const multipart=body instanceof FormData, payload=body===undefined||multipart?'':JSON.stringify(body);
    const url=new URL(path,'https://open-api.tiktokglobalshop.com');url.search=new URLSearchParams({...params,sign:await sign(path,params,payload,secret)}).toString();
    let response:Response;try { response=await request(url,{method,headers:{...(!multipart?{'content-type':'application/json'}:{}),'x-tts-access-token':token},body:multipart?body:body===undefined?undefined:payload,redirect:'error',signal:AbortSignal.timeout(20000)}); } catch { throw Error('TikTok did not confirm the request. Check the conversation before trying again.'); }
    let result:any;try { result=await response.json(); } catch { throw Error('TikTok returned an unreadable response. Check the conversation before trying again.'); }
    if (!response.ok || result.code!==0) throw new TikTokError(String(result.code??response.status).replace(/[^0-9]/g,'').slice(0,12),String(result.request_id||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,100));
    return result.data || {};
  }
  return {async read(path:string, token:string, query:Record<string,string>) {
    if (path!==CONVERSATIONS_PATH && !/^\/customer_service\/202309\/conversations\/\d{10,30}\/messages$/.test(path)) throw Error('Unsupported TikTok chat read endpoint.');
    return await call(path,token,query,'GET');
  },async send(conversationId:string, token:string, shop:string, type:string, content:Record<string,unknown>) {
    id(conversationId);
    if(!['TEXT','IMAGE','ORDER_CARD'].includes(type))throw Error('Unsupported reply type.');
    const result=await call(`${SEND_PATH}/${conversationId}/messages`,token,{shop_cipher:shop},'POST',{type,content:JSON.stringify(content)});
    if(!validId(result.message_id))throw Error('TikTok did not return a message receipt. Check the conversation before trying again.');
    return result.message_id as string;
  },async upload(file:File,token:string,shop:string) {
    await validateImage(file);
    const form=new FormData();form.append('data',file,'reply.'+({'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp'} as Record<string,string>)[file.type]);
    const result=await call('/customer_service/202309/images/upload',token,{shop_cipher:shop},'POST',form);
    const url=mediaUrl(result.url);
    if(!url||!Number.isSafeInteger(result.width)||result.width<1||!Number.isSafeInteger(result.height)||result.height<1)throw Error('TikTok could not prepare this photo. No message was sent.');
    return {url,width:result.width,height:result.height};
  },async markRead(conversationId:string,token:string,shop:string) {
    id(conversationId);await call(`${CONVERSATIONS_PATH}/${conversationId}/messages/read`,token,{shop_cipher:shop},'POST');
  },async open(buyer:string,token:string,shop:string) {
    id(buyer);const result=await call(CONVERSATIONS_PATH,token,{shop_cipher:shop},'POST',{buyer_user_id:buyer});return id(result.conversation_id);
  }};
}

export async function validateImage(file:File) {
 if(!(file instanceof File)||!file.size||file.size>MAX_IMAGE_BYTES)throw Error('Choose a photo no larger than 10 MB.');
 const bytes=new Uint8Array(await file.slice(0,16).arrayBuffer()), ascii=new TextDecoder().decode(bytes);
 const ok=file.type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
  file.type==='image/png'?[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v):
  file.type==='image/gif'?/^GIF8[79]a/.test(ascii):file.type==='image/webp'?ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WEBP':false;
 if(!ok)throw Error('Choose a valid JPG, PNG, GIF or WebP photo.');
}

export const definitiveRejection=(e:unknown)=>e instanceof TikTokError&&['105005','45101002','45101003','45101004','45101006','45102007','45109001','45111001'].includes(e.code);
export function replyError(e:unknown) {
 if(e instanceof TikTokError){const labels:Record<string,string>={
  '45109001':'TikTok has closed this reply window. Use Reopen chat, then try again.',
  '45109003':'TikTok does not allow this buyer conversation to be opened right now.',
  '45101006':'TikTok rejected the message content. Edit your reply before sending again.',
  '45101004':'TikTok’s daily messaging limit has been reached. Try again tomorrow.',
  '105005':'TikTok Customer Service permission needs attention. Reconnect the shop.',
  '45102007':'TikTok does not allow access to this conversation.'};return labels[e.code]||`TikTok could not complete this request (code ${e.code}).`;}
 return e instanceof Error&&!/https?:|TTP_|token=|secret=/i.test(e.message)?e.message.slice(0,300):'TikTok did not confirm this request.';
}
