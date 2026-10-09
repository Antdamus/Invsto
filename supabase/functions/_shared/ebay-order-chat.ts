type Db = any;
export class OrderChatError extends Error {
  code: string; status: number; phase = 'order_chat';
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
const clean = (value: unknown) => String(value || '').trim();
const normalized = (value: unknown) => clean(value).toLowerCase();
const exactPattern = (value: string) => value.replace(/[\\%_*]/g, '\\$&');
const uuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value));
async function read(query: any) {
  const { data, error } = await query;
  if (error) throw new OrderChatError('order_chat_database_error', 'Could not load or save this order’s chat. Please try again.', 500);
  return data;
}

export async function orderChatContext(db: Db, lineId: string, accountKey: string) {
  if (!uuid(lineId)) throw new OrderChatError('order_line_required', 'Open chat from an order item.');
  const line = await read(db.from('ebay_order_lines').select('id,order_id,item_number,item_title,quantity').eq('id', lineId).maybeSingle());
  if (!line) throw new OrderChatError('order_line_not_found', 'This order item could not be found.', 404);
  const [order, account] = await Promise.all([
    read(db.from('ebay_orders').select('id,order_number,buyer_username,status,sale_date').eq('id', line.order_id).maybeSingle()),
    read(db.from('ebay_seller_accounts').select('id,seller_username,account_key,status').eq('account_key', accountKey).maybeSingle()),
  ]);
  if (!order) throw new OrderChatError('order_not_found', 'This order could not be found.', 404);
  if (!account || account.status !== 'active') throw new OrderChatError('seller_account_unavailable', 'The eBay messaging account is unavailable.', 409);
  const buyer = clean(order.buyer_username);
  if (!buyer) throw new OrderChatError('order_buyer_missing', 'This order has no eBay buyer username. Add it before opening a chat.', 409);
  const columns = 'id,seller_account_id,conversation_type,ebay_conversation_id,other_party_username,reference_id,reference_type,conversation_title,latest_message_preview,latest_message_created_at';
  const [buyerChats, itemChats, links, starts, buyerLinks, legacyBuyerLinks] = await Promise.all([
    read(db.from('ebay_conversations').select(columns).eq('seller_account_id', account.id).eq('conversation_type', 'FROM_MEMBERS').ilike('other_party_username', exactPattern(buyer)).order('latest_message_created_at', { ascending: false }).limit(101)),
    line.item_number ? read(db.from('ebay_conversations').select(columns).eq('seller_account_id', account.id).eq('conversation_type', 'FROM_MEMBERS').eq('reference_id', line.item_number).limit(101)) : [],
    read(db.from('ebay_conversation_links').select('conversation_id,ebay_order_id,ebay_order_line_id,status,match_method').eq('seller_account_id', account.id).eq('ebay_order_id', order.id).eq('status', 'confirmed').limit(201)),
    read(db.from('ebay_order_chat_starts').select('id,status,conversation_id,error_message,created_at').eq('order_line_id', lineId).in('status', ['sending','sent','unknown']).limit(1)),
    read(db.from('ebay_conversation_links').select('conversation_id,buyer_username,matched_value,match_method').eq('seller_account_id', account.id).eq('link_type', 'buyer_username').eq('status', 'confirmed').ilike('buyer_username', exactPattern(buyer)).limit(201)),
    read(db.from('ebay_conversation_links').select('conversation_id,buyer_username,matched_value,match_method').eq('seller_account_id', account.id).eq('link_type', 'buyer_username').eq('status', 'confirmed').ilike('matched_value', exactPattern(buyer)).limit(201)),
  ]);
  const verifiedBuyerIds = new Set([...buyerLinks, ...legacyBuyerLinks].filter((l: any) =>
    normalized(l.buyer_username || l.matched_value) === normalized(buyer)
  ).map((l: any) => l.conversation_id));
  const ids = [...new Set([...verifiedBuyerIds, ...links.map((l: any) => l.conversation_id), ...starts.map((s: any) => s.conversation_id).filter(Boolean)])];
  const linkedChats = ids.length ? await read(db.from('ebay_conversations').select(columns).eq('seller_account_id', account.id).eq('conversation_type', 'FROM_MEMBERS').in('id', ids).limit(202)) : [];
  const all = [...new Map([...buyerChats, ...itemChats, ...linkedChats].map((c: any) => [c.id, c])).values()] as any[];
  // A listing/order reference alone never authorizes crossing buyer identities.
  const rank: Record<string, number> = {item:0,order:1,listing:2,buyer:3};
  const chats = all.filter(c => normalized(c.other_party_username) === normalized(buyer)
    || (!clean(c.other_party_username) && verifiedBuyerIds.has(c.id))).map(c => {
    // Older imports may have marked a time-proximity guess as confirmed.
    const direct = links.filter((l: any) => l.conversation_id === c.id && l.match_method !== 'buyer_recent_unique_order');
    const match = direct.some((l: any) => l.ebay_order_line_id === lineId) ? 'item'
      : direct.length ? 'order' : clean(c.reference_id) === clean(line.item_number) && clean(line.item_number) ? 'listing' : 'buyer';
    return { ...c, match };
  }).sort((a,b) => (rank[a.match] - rank[b.match]) || clean(b.latest_message_created_at).localeCompare(clean(a.latest_message_created_at)));
  const exact = chats.filter(c => c.match !== 'buyer');
  const truncated = buyerChats.length > 100 || itemChats.length > 100 || links.length > 200 || buyerLinks.length > 200 || legacyBuyerLinks.length > 200 || ids.length > 202;
  return { ok: true, line, order, account, conversations: chats, preferred_conversation_id: !truncated && exact.length === 1 ? exact[0].id : null, has_more: truncated, start: starts[0] || null };
}

export async function startOrderChat(db: Db, input: any, actor: any, deps: any) {
  if (!actor.userId || input.sendConfirmed !== true) throw new OrderChatError('send_confirmation_required', 'Review your message and click Send to buyer.');
  if (!uuid(input.requestId)) throw new OrderChatError('request_id_required', 'Please reopen the message composer.');
  const body = String(input.draftText || '').trim();
  if (!body || body.length > 2000) throw new OrderChatError('message_text_invalid', 'Enter a message of up to 2,000 characters.');
  const ctx = await orderChatContext(db, input.orderLineId, deps.accountKey);
  const digest = await deps.sha256Hex(body);
  const prior = await read(db.from('ebay_order_chat_starts').select('*').eq('id', input.requestId).maybeSingle());
  if (prior && (prior.order_line_id !== ctx.line.id || prior.body_sha256 !== digest || prior.created_by !== actor.userId)) {
    throw new OrderChatError('send_request_mismatch', 'This send request has changed. Check its delivery before starting another.', 409);
  }
  if (prior && prior.status !== 'failed') return { ok: true, delivery_status: prior.status, conversation_id: prior.conversation_id, duplicate_prevented: true };
  if (ctx.start) return { ok: true, delivery_status: ctx.start.status, conversation_id: ctx.start.conversation_id, duplicate_prevented: true };
  if (ctx.conversations.some((c: any) => c.match !== 'buyer')) throw new OrderChatError('order_chat_already_exists', 'A chat for this item is now available. Refresh and open that conversation.', 409);
  if (!/^\d{9,15}$/.test(clean(ctx.line.item_number))) throw new OrderChatError('ebay_listing_required', 'A valid eBay item number is needed to start this order’s chat.', 409);
  if (prior) throw new OrderChatError('previous_send_failed', 'The previous attempt was rejected. Start a new attempt after reviewing the message.', 409);
  // Obtain OAuth before claiming a delivery. Never retry the provider POST automatically.
  const token = await deps.refreshEbayToken();
  const attempt = { id: input.requestId, order_line_id: ctx.line.id, seller_account_id: ctx.account.id, buyer_username: ctx.order.buyer_username, body_sha256: digest, message_text: body, status: 'sending', created_by: actor.userId };
  const { error: claimError } = await db.from('ebay_order_chat_starts').insert(attempt);
  if (claimError) {
    if (claimError.code === '23505') return { ok: true, delivery_status: 'sending', duplicate_prevented: true };
    throw new OrderChatError('send_claim_failed', 'Could not save this message before sending. Nothing was sent.', 500);
  }
  const update = (patch: any) => read(db.from('ebay_order_chat_starts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', attempt.id));
  let result;
  try {
    result = await deps.ebayPost(token, '/commerce/message/v1/send_message', {
      otherPartyUsername: ctx.order.buyer_username, messageText: body, emailCopyToSender: false,
      reference: { referenceId: clean(ctx.line.item_number), referenceType: 'LISTING' },
    });
  } catch {
    await update({ status: 'unknown', error_message: 'Delivery could not be confirmed. Check eBay before sending again.' });
    return { ok: true, delivery_status: 'unknown' };
  }
  if (!result.ok) {
    // A server/proxy failure can occur after delivery; only explicit 4xx rejection is safe to retry.
    const status = result.status >= 400 && result.status < 500 && ![408,409,425,429].includes(result.status) ? 'failed' : 'unknown';
    await update({ status, provider_response: result.payload, error_message: deps.safeMessage(result.payload) });
    return { ok: true, delivery_status: status, message: status === 'failed' ? deps.safeMessage(result.payload) : 'Delivery is uncertain. Check eBay before sending again.' };
  }
  const payload = result.payload || {};
  const providerId = clean(payload.conversationId || payload.conversation?.conversationId);
  const messageId = clean(payload.messageId || payload.message?.messageId);
  // Persist acceptance first. Even if local chat storage fails, another click cannot resend.
  await update({ status: 'sent', provider_conversation_id: providerId || null, provider_message_id: messageId || null, provider_response: payload });
  if (!providerId) return { ok: true, delivery_status: 'sent', awaiting_sync: true };
  try {
    const sentAt = new Date().toISOString();
    const chat = await read(db.from('ebay_conversations').upsert({ seller_account_id: ctx.account.id, ebay_conversation_id: providerId, conversation_type: 'FROM_MEMBERS', other_party_username: ctx.order.buyer_username, reference_id: clean(ctx.line.item_number), reference_type: 'LISTING', conversation_title: ctx.line.item_title, latest_message_preview: body.slice(0,240), latest_message_created_at: sentAt }, { onConflict: 'seller_account_id,conversation_type,ebay_conversation_id' }).select('id').single());
    await update({ conversation_id: chat.id });
    await read(db.from('ebay_conversation_links').upsert({ conversation_id: chat.id, seller_account_id: ctx.account.id, link_type: 'ebay_order_line', link_key: `order-chat:${ctx.line.id}`, ebay_order_id: ctx.order.id, ebay_order_line_id: ctx.line.id, buyer_username: ctx.order.buyer_username, match_method: 'operator_order_chat', confidence: 1, status: 'confirmed', created_by: actor.userId }, { onConflict: 'conversation_id,link_type,link_key' }));
    if (messageId) await read(db.from('ebay_conversation_messages').upsert({ conversation_id: chat.id, seller_account_id: ctx.account.id, ebay_conversation_id: providerId, conversation_type: 'FROM_MEMBERS', ebay_message_id: messageId, sender_username: ctx.account.seller_username, recipient_username: ctx.order.buyer_username, direction: 'outbound', direction_confidence: 'strong', direction_reason: 'local_order_chat_send', message_body: body, message_body_preview: body.slice(0,240), message_status: 'sent', is_read: true, created_at_ebay: sentAt, raw_message_metadata: { order_chat_start_id: attempt.id } }, { onConflict: 'seller_account_id,conversation_type,ebay_conversation_id,ebay_message_id' }));
    return { ok: true, delivery_status: 'sent', conversation_id: chat.id };
  } catch { return { ok: true, delivery_status: 'sent', awaiting_sync: true }; }
}
