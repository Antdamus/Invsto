import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {client, seal, unseal, sha256, chooseProductionShop, mapOrder, SHOPS_PATH, ORDER_PATH, TikTokError} from './tiktok.ts';

const APP_URL = 'https://antdamus.github.io/Invsto/pending-tiktok-orders.html';
const ORIGIN = new URL(APP_URL).origin;
const CORS = {'Access-Control-Allow-Origin':ORIGIN, 'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Vary':'Origin', 'Cache-Control':'no-store'};
const env = (name: string) => { const value = Deno.env.get(name); if (!value) throw Error('TikTok API setup is not configured on the server.'); return value; };
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), {status, headers:{...CORS,'Content-Type':'application/json'}});
const check = (result: any) => { if (result.error) throw Error('Could not save TikTok connection progress. Retry shortly.'); return result.data; };
const safeError = (error: unknown) => error instanceof TikTokError ? error.message : error instanceof Error && !/https?:|token=|secret=|TTP_/i.test(error.message) ? error.message.slice(0, 400) : 'TikTok sync could not finish. Try again shortly.';
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

async function worker(db: any, workerToken: string) {
  const c = check(await db.rpc('claim_tiktok_api_worker', {_token:workerToken}));
  if (!c) return json(409, {error:'Sync request has expired or is already running.'});
  try {
    if (!check(await db.rpc('tiktok_api_authorizer_allowed', {_user:c.authorized_by}))) throw Error('An administrator must reconnect TikTok to continue syncing.');
    const api = client(env('TIKTOK_APP_KEY'), env('TIKTOK_APP_SECRET'));
    let tokens = await unseal(c.credentials, env('TIKTOK_TOKEN_ENCRYPTION_KEY'));
    if (tokens.refresh_token_expire_in <= Date.now()/1000) throw Error('TikTok authorization expired. Reconnect the shop.');
    if (tokens.access_token_expire_in < Date.now()/1000 + 600) {
      tokens = await api.token(tokens.refresh_token, true);
      const updated = check(await db.from('tiktok_api_connection').update({credentials:await seal(tokens, env('TIKTOK_TOKEN_ENCRYPTION_KEY')), access_expires_at:iso(tokens.access_token_expire_in),authorization_expires_at:iso(tokens.refresh_token_expire_in)}).eq('singleton',true).eq('dispatch_token',workerToken).select('singleton'));
      if (updated.length !== 1) throw Error('TikTok sync lease expired.');
    }
    const query: Record<string,string> = {shop_cipher:c.shop_cipher,page_size:'50',sort_field:'update_time',sort_order:'ASC'};
    if (c.page_token) query.page_token = c.page_token;
    const page = await api.read(ORDER_PATH, tokens.access_token, query, {update_time_ge:Math.floor(Date.parse(c.window_from)/1000),update_time_lt:Math.floor(Date.parse(c.window_to)/1000)});
    if (!Array.isArray(page.orders)) throw Error('TikTok returned an invalid order page.');
    if (page.next_page_token && page.next_page_token === c.page_token) throw Error('TikTok repeated its page cursor. Retry shortly.');
    const existing = page.orders.length ? check(await db.from('tiktok_orders').select('order_number,buyer_username,api_buyer_id').in('order_number',page.orders.map((o: any) => o.id))) : [];
    const buyerIds = page.orders.map((o: any) => o.user_id).filter(Boolean);
    const knownBuyers = buyerIds.length ? check(await db.from('tiktok_orders').select('buyer_username,api_buyer_id').in('api_buyer_id',buyerIds)) : [];
    const names = new Map<string,string>(knownBuyers.map((o: any) => [o.api_buyer_id,o.buyer_username]));
    for (const order of page.orders) { const old = existing.find((o: any) => o.order_number === order.id); if (old) names.set(order.user_id,old.buyer_username); }
    // Validate the entire page before importing. A bad item never silently drops an order.
    const batches = page.orders.map((order: any) => mapOrder(order,names.get(order.user_id)));
    let saved = 0;
    for (const rows of batches) {
      const hash = await sha256(JSON.stringify({shop:c.shop_id,rows}));
      check(await db.rpc('import_tiktok_api_order',{_token:workerToken,_rows:rows,_hash:hash})); saved++;
    }
    const more = Boolean(page.next_page_token);
    const changes = more ? {page_token:page.next_page_token,next_sync_at:new Date().toISOString()} : {page_token:null,window_from:null,window_to:null,cursor_at:c.window_to,last_synced_at:new Date().toISOString(),next_sync_at:new Date(Date.now()+300000).toISOString()};
    check(await db.from('tiktok_api_connection').update({...changes,last_error:null,dispatch_token:null,lease_until:null,claimed:false}).eq('singleton',true).eq('dispatch_token',workerToken));
    return json(200,{ok:true,orders_read:saved,more});
  } catch (error) {
    const message = safeError(error);
    await db.from('tiktok_api_connection').update({last_error:message,next_sync_at:new Date(Date.now()+300000).toISOString(),dispatch_token:null,lease_until:null,claimed:false}).eq('singleton',true).eq('dispatch_token',workerToken);
    return json(502,{error:message});
  }
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null,{status:204,headers:CORS});
  let db: any;
  try {
    const url = new URL(req.url);
    db = createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
    if (req.method === 'GET') {
      const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
      if (!/^[a-f0-9]{64}$/.test(state) || !code || code === 'null' || code.length>2048 || url.searchParams.has('error')) throw Error('TikTok connection was cancelled or expired. Start again from Invsto.');
      const actor = check(await db.rpc('consume_tiktok_oauth_state',{_hash:await sha256(state)}));
      if (!actor || !check(await db.rpc('tiktok_api_authorizer_allowed',{_user:actor}))) throw Error('This connection request expired. Start again from Invsto.');
      const api = client(env('TIKTOK_APP_KEY'),env('TIKTOK_APP_SECRET'));
      const tokens = await api.token(code);
      const shops = await api.read(SHOPS_PATH,tokens.access_token);
      const old = check(await db.from('tiktok_api_connection').select('shop_id,lease_until').eq('singleton',true).maybeSingle());
      const shop = chooseProductionShop(shops.shops,old?.shop_id);
      if (old?.lease_until && Date.parse(old.lease_until)>Date.now()) throw Error('A TikTok sync is running. Reconnect after it finishes.');
      check(await db.rpc('install_tiktok_api_connection',{_shop_id:shop.id,_shop_cipher:shop.cipher,_shop_name:shop.name,_credentials:await seal(tokens,env('TIKTOK_TOKEN_ENCRYPTION_KEY')),_actor:actor,_access_expires:iso(tokens.access_token_expire_in),_authorization_expires:iso(tokens.refresh_token_expire_in)}));
      check(await db.rpc('dispatch_tiktok_api_worker'));
      return new Response(null,{status:303,headers:{Location:APP_URL+'?tiktokApi=connected','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    }
    if (req.method !== 'POST') return json(405,{error:'Method not allowed'});
    const bodyText = await req.text(); if (bodyText.length>4096) return json(413,{error:'Request too large'});
    const body = JSON.parse(bodyText);
    if (body.workerToken) {
      if (!/^[0-9a-f-]{36}$/.test(body.workerToken)) return json(401,{error:'Invalid sync request'});
      return await worker(db,body.workerToken);
    }
    const authorization = req.headers.get('Authorization') || '';
    if (!authorization.startsWith('Bearer ')) return json(401,{error:'Sign in to Invsto.'});
    const userDb = createClient(env('SUPABASE_URL'),env('SUPABASE_ANON_KEY'),{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
    const auth = await userDb.auth.getUser();
    if (auth.error || !auth.data.user) return json(401,{error:'Sign in to Invsto.'});
    if (check(await userDb.rpc('can_manage_inventory')) !== true) return json(403,{error:'Inventory staff access required.'});
    const admin = check(await userDb.rpc('is_admin')) === true;
    if (body.action === 'status') {
      const c = check(await db.from('tiktok_api_connection').select('shop_name,shop_id,enabled,connected_at,last_synced_at,last_error,authorization_expires_at,lease_until,page_token').eq('singleton',true).maybeSingle());
      const configured = Boolean(Deno.env.get('TIKTOK_APP_KEY') && Deno.env.get('TIKTOK_APP_SECRET') && Deno.env.get('TIKTOK_TOKEN_ENCRYPTION_KEY'));
      return json(200,{configured,admin,connection:c ? {...c,page_token:undefined,syncing:Boolean(c.page_token || c.lease_until && Date.parse(c.lease_until)>Date.now())} : null});
    }
    if (body.action === 'connect') {
      if (!admin) return json(403,{error:'Only administrators can connect TikTok.'});
      env('TIKTOK_APP_SECRET');env('TIKTOK_TOKEN_ENCRYPTION_KEY');
      const state = Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
      check(await db.from('tiktok_api_oauth_states').delete().eq('requested_by',auth.data.user.id));
      check(await db.from('tiktok_api_oauth_states').insert({state_hash:await sha256(state),requested_by:auth.data.user.id,expires_at:new Date(Date.now()+1800000).toISOString()}));
      const authorize = new URL('https://services.tiktokshops.us/open/authorize');
      authorize.search = new URLSearchParams({service_id:env('TIKTOK_SERVICE_ID'),state}).toString();
      return json(200,{url:authorize.toString()});
    }
    if (body.action === 'sync') {
      check(await db.from('tiktok_api_connection').update({next_sync_at:new Date().toISOString()}).eq('singleton',true).eq('enabled',true));
      check(await db.rpc('dispatch_tiktok_api_worker'));return json(202,{ok:true,queued:true});
    }
    if (body.action === 'pause' || body.action === 'resume') {
      if (!admin) return json(403,{error:'Only administrators can change automatic sync.'});
      check(await db.from('tiktok_api_connection').update({enabled:body.action === 'resume',next_sync_at:new Date().toISOString()}).eq('singleton',true));
      if (body.action === 'resume') check(await db.rpc('dispatch_tiktok_api_worker'));
      return json(200,{ok:true});
    }
    return json(400,{error:'Unknown TikTok action.'});
  } catch (error) {
    const message = safeError(error);
    if (req.method === 'GET') {
      const escaped = message.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
      return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>TikTok connection</title><h1>TikTok connection needs attention</h1><p>${escaped}</p><p><a href="${APP_URL}">Return to Invsto</a></p>`,{status:400,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'"}});
    }
    return json(400,{error:message});
  }
});
