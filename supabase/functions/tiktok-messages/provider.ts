import {sign, TikTokError} from '../tiktok-order-sync/tiktok.ts';

export const CHAT_SCOPE = 'seller.customer_service';
export const CONVERSATIONS_PATH = '/customer_service/202309/conversations';
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
  return {async read(path:string, token:string, query:Record<string,string>) {
    if (path!==CONVERSATIONS_PATH && !/^\/customer_service\/202309\/conversations\/\d{10,30}\/messages$/.test(path)) throw Error('Unsupported TikTok chat read endpoint.');
    const params={...query,app_key:appKey,timestamp:String(Math.floor(Date.now()/1000))};
    const url=new URL(path,'https://open-api.tiktokglobalshop.com');url.search=new URLSearchParams({...params,sign:await sign(path,params,'',secret)}).toString();
    let response:Response;try { response=await request(url,{method:'GET',headers:{'content-type':'application/json','x-tts-access-token':token},redirect:'error',signal:AbortSignal.timeout(20000)}); } catch { throw Error('TikTok chats could not be reached. Try again shortly.'); }
    let result:any;try { result=await response.json(); } catch { throw Error('TikTok returned an unreadable chat response.'); }
    if (!response.ok || result.code!==0 || !result.data) throw new TikTokError(String(result.code??response.status).replace(/[^0-9]/g,'').slice(0,12),String(result.request_id||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,100));
    return result.data;
  }};
}
