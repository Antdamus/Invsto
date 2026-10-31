// TikTok Shop seller APIs. Credentials and signed URLs must never reach logs or the browser.
const encoder = new TextEncoder();
export const REQUIRED_SCOPES = ['seller.order.info', 'seller.authorization.info'];
export const API_ORIGIN = 'https://open-api.tiktokglobalshop.com';
export const AUTH_ORIGIN = 'https://auth.tiktok-shops.com';
export const ORDER_PATH = '/order/202309/orders/search';
export const SHOPS_PATH = '/authorization/202309/shops';
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
export async function sign(path: string, params: Record<string, string>, body: string, secret: string) {
  const values = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort().map(k => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(secret + path + values + body + secret)));
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export async function seal(value: unknown, keyBase64: string) {
  const key = await crypto.subtle.importKey('raw', unb64(keyBase64), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:encoder.encode('invsto:tiktok:v1')}, key, encoder.encode(JSON.stringify(value)));
  return 'v1.' + b64(iv) + '.' + b64(new Uint8Array(ciphertext));
}
export async function unseal(value: string, keyBase64: string) {
  const [version, iv, ciphertext] = value.split('.');
  if (version !== 'v1') throw Error('Unsupported TikTok credential format');
  const key = await crypto.subtle.importKey('raw', unb64(keyBase64), 'AES-GCM', false, ['decrypt']);
  const clear = await crypto.subtle.decrypt({name:'AES-GCM', iv:unb64(iv), additionalData:encoder.encode('invsto:tiktok:v1')}, key, unb64(ciphertext));
  return JSON.parse(new TextDecoder().decode(clear));
}
export class TikTokError extends Error {
  code: string;
  requestId: string;
  constructor(code: string, requestId: string) { super(`TikTok request failed (${code}; request ${requestId || 'unavailable'}).`); this.code=code; this.requestId=requestId; }
}
async function responseData(response: Response) {
  let result: any;
  try { result = await response.json(); } catch { throw new TikTokError(String(response.status), ''); }
  if (!response.ok || result.code !== 0 || !result.data) {
    // TikTok messages can echo request parameters, including credentials.
    throw new TikTokError(String(result.code ?? response.status).replace(/[^0-9]/g, '').slice(0, 12), String(result.request_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100));
  }
  return result.data;
}
export function validateTokens(tokens: any, now = Math.floor(Date.now() / 1000)) {
  if (tokens.user_type !== 0 || tokens.seller_base_region !== 'US') throw Error('Authorize the US seller account for this connection.');
  if (!REQUIRED_SCOPES.every(scope => tokens.granted_scopes?.includes(scope))) throw Error('TikTok did not grant both required order and shop scopes. Reconnect the shop.');
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token ||
      !Number.isSafeInteger(tokens.access_token_expire_in) || tokens.access_token_expire_in <= now ||
      !Number.isSafeInteger(tokens.refresh_token_expire_in) || tokens.refresh_token_expire_in <= now) throw Error('TikTok returned an invalid or expired authorization.');
  return tokens;
}
export function chooseProductionShop(shops: any[], existingId?: string) {
  if (!Array.isArray(shops) || shops.length !== 1) throw Error('This connection requires exactly one authorized shop.');
  const shop = shops[0];
  if (!/^\d{10,24}$/.test(shop.id) || !shop.cipher || shop.region !== 'US' || /^SANDBOX/i.test(shop.name || '') || shop.id === '7494924429697648413') throw Error('Authorize your real US shop. Development shops cannot sync into Invsto.');
  if (existingId && existingId !== shop.id) throw Error('This authorization belongs to a different shop. The existing connection was preserved.');
  return shop;
}
export function client(appKey: string, appSecret: string, request: typeof fetch = fetch) {
  return {
    async token(value: string, refresh = false) {
      const url = new URL('/api/v2/token/' + (refresh ? 'refresh' : 'get'), AUTH_ORIGIN);
      url.search = new URLSearchParams({app_key:appKey, app_secret:appSecret, grant_type:refresh ? 'refresh_token' : 'authorized_code', [refresh ? 'refresh_token' : 'auth_code']:value}).toString();
      try { return validateTokens(await responseData(await request(url, {redirect:'error', signal:AbortSignal.timeout(20000)}))); }
      catch (error) { if (error instanceof TikTokError || error instanceof Error && !/fetch|network|https?:/i.test(error.message)) throw error; throw Error('TikTok authorization request could not finish. Retry the connection.'); }
    },
    async read(path: string, token: string, query: Record<string, string> = {}, body?: Record<string, unknown>) {
      if (path !== ORDER_PATH && path !== SHOPS_PATH && path !== '/order/202507/orders' && path !== '/finance/202507/orders/unsettled' && !/^\/finance\/202501\/orders\/\d{10,24}\/statement_transactions$/.test(path)) throw Error('Unsupported TikTok read endpoint');
      const params = {...query, app_key:appKey, timestamp:String(Math.floor(Date.now() / 1000))};
      const payload = body === undefined ? '' : JSON.stringify(body);
      const url = new URL(path, API_ORIGIN);
      url.search = new URLSearchParams({...params, sign:await sign(path, params, payload, appSecret)}).toString();
      try { return await responseData(await request(url, {method:body === undefined ? 'GET' : 'POST', headers:{'content-type':'application/json','x-tts-access-token':token}, body:body === undefined ? undefined : payload, redirect:'error', signal:AbortSignal.timeout(20000)})); }
      catch (error) { if (error instanceof TikTokError) throw error; throw Error('TikTok order request could not finish. No sync progress was advanced.'); }
    }
  };
}

const statuses: Record<string, [string, string]> = {
  UNPAID:['Unpaid','Unpaid'], ON_HOLD:['Pending','On hold'], AWAITING_SHIPMENT:['To ship','Awaiting shipment'],
  PARTIALLY_SHIPPING:['To ship','Partially shipped'], AWAITING_COLLECTION:['To ship','Awaiting collection'],
  IN_TRANSIT:['Shipped','In transit'], DELIVERED:['Shipped','Delivered'], COMPLETED:['Completed','Completed'], CANCELLED:['Canceled','Canceled']
};
const id = (value: unknown, label: string) => { if (typeof value !== 'string' || !/^\d{10,24}$/.test(value)) throw Error(`Invalid TikTok ${label}`); return value; };
function cents(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(value)) throw Error('Invalid TikTok USD amount');
  const [whole, fraction = ''] = value.split('.'); return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
function time(value: unknown) { if (value == null || value === 0) return null; if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error('Invalid TikTok timestamp'); return new Date(Number(value) * 1000).toISOString(); }
function shopTime(value: unknown) {
  const instant = time(value); if (!instant) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
export function mapOrder(order: any, knownBuyer?: string) {
  const number = id(order.id, 'order ID'), buyerId = id(order.user_id, 'buyer ID');
  const status = statuses[order.status]; if (!status) throw Error(`Unsupported TikTok order status for ${number}`);
  if (order.payment?.currency !== 'USD') throw Error(`Unsupported currency for TikTok order ${number}`);
  if (!Array.isArray(order.line_items) || !order.line_items.length) throw Error(`TikTok order ${number} has no items`);
  const lines = new Map<string, any>(), seen = new Set<string>();
  let review = false;
  for (const item of order.line_items) {
    const lineId = id(item.id, 'line ID'), sku = id(item.sku_id, 'SKU ID');
    if (seen.has(lineId) || !statuses[item.display_status] || item.currency !== 'USD' || !item.product_name) throw Error(`Invalid or duplicate TikTok item for ${number}`);
    seen.add(lineId);
    // The order API returns one line item per unit; it has no quantity field.
    let line = lines.get(sku);
    if (!line) { line = {sku_id:sku, product_id:id(item.product_id, 'product ID'), title:String(item.product_name).slice(0, 1000), seller_sku:item.seller_sku || '', variation:item.sku_name || '', quantity:0, amount:0, cancelled:0, tracking:new Set<string>()}; lines.set(sku, line); }
    line.quantity++; line.amount += cents(item.sale_price); line.cancelled += Number(item.display_status === 'CANCELLED');
    if (item.tracking_number) line.tracking.add(String(item.tracking_number));
  }
  for (const line of lines.values()) if (line.cancelled > 0 && line.cancelled < line.quantity) review = true;
  const shared = {
    order_number:number, buyer_username:knownBuyer || `TikTok buyer ${buyerId}`, buyer_nickname:/[*•]/.test(order.buyer_nickname || '') ? '' : String(order.buyer_nickname || '').slice(0, 240),
    recipient_name:/[*•]/.test(order.recipient_address?.name || '') ? '' : String(order.recipient_address?.name || '').slice(0, 240),
    marketplace_status:status[0], marketplace_substatus:status[1], order_amount:(cents(order.payment.total_amount) / 100).toFixed(2),
    created_time:shopTime(order.create_time), paid_time:shopTime(order.paid_time), shipped_time:shopTime(order.collection_time),
    ship_by_date:shopTime(order.shipping_due_time)?.slice(0,10) || null,
    buyer_message:String(order.buyer_message || '').slice(0, 4000), shipping_method:String(order.delivery_option_name || '').slice(0, 240),
    cancel_return:review ? 'TikTok API: partially cancelled quantity within one SKU. Verify the item quantities in TikTok before packing.' : order.is_buyer_request_cancel ? 'TikTok buyer requested cancellation. Review in TikTok.' : order.cancel_reason || '',
    api_buyer_id:buyerId, api_update_time:time(order.update_time)
  };
  return Array.from(lines.values(), line => ({...shared, sku_id:line.sku_id, product_id:line.product_id, title:line.title, seller_sku:line.seller_sku, variation:line.variation, quantity:line.quantity, line_amount:(line.amount / 100).toFixed(2), tracking_number:Array.from(line.tracking).join(', '), api_cancelled:line.cancelled === line.quantity}));
}
