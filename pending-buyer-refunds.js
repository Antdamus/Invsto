/* Buyer history is read on demand; it never changes fulfillment or refund records. */
(function(root) {
  'use strict';
  const refunds = root.OGBuyerRefundReport || (typeof require === 'function' ? require('./buyer-report-refunds.js') : null);
  const key = value => String(value || '').trim().toLowerCase();
  const unique = rows => [...new Map(rows.map(row => [row.id, row])).values()];
  const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const labels = {after_shipment:'Refunds / requests after shipment',after_completion:'After system completion — shipment unconfirmed',
    before_shipment:'Refunds / cancellations before shipment',timing_unknown:'Refund / cancellation timing needs verification',none:'No refund or cancellation recorded',unknown:'Buyer history not checked'};
  const ranks = {after_shipment:0,after_completion:1,before_shipment:2,timing_unknown:3,none:4,unknown:5};
  const statusRanks = {confirmed:0,requested:1,verification:2,cancelled:3,none:4,unknown:5};
  const signalSelect = 'payment_status:raw_payload->>orderPaymentStatus,order_payment_status:raw_payload->order->>orderPaymentStatus,api_payment_status:raw_payload->api_order_status->>payment_status,finance_transactions:raw_payload->ebayFinance->transactions,source:raw_payload->>source,fulfillment_status:raw_payload->>orderFulfillmentStatus,order_fulfillment_status:raw_payload->order->>orderFulfillmentStatus,api_fulfillment_status:raw_payload->api_order_status->>fulfillment_status,cancel_status:raw_payload->>orderCancelStatus,api_cancel_status:raw_payload->api_order_status->>cancel_status,order_cancel:raw_payload->order->cancelStatus,api_cancel:raw_payload->api_cancellation_case,page_cancel:raw_payload->cancellation_page_case';
  const orderSelect = `id,order_number,buyer_username,total_price,status,shipped_on_date,${signalSelect},payment_refunds:raw_payload->order->paymentSummary->refunds,order_total:raw_payload->order->pricingSummary->total,import_currency:raw_payload->first_row->>Currency,shipped_precision:raw_payload->date_precision->>shipped_on_date,csv_shipped:raw_payload->first_row->>"Shipped On Date",api_shipped:raw_payload->order->>shippedDate,summary_shipped:raw_payload->order->fulfillmentSummary->>shippedDate,status_shipped:raw_payload->order->fulfillmentStatus->>shippedDate,fulfillment_shipped:raw_payload->order->shippingFulfillment->>shippedDate,fulfillments:raw_payload->order->fulfillments,shipping_fulfillments:raw_payload->order->shippingFulfillments`;
  const lineSelect = `id,order_id,line_status,fulfilled_at,${signalSelect},history_corrected:raw_payload->>history_date_corrected_at,line_shipped:raw_payload->line->>shippedDate,instructions_shipped:raw_payload->line->lineItemFulfillmentInstructions->>shippedDate,fulfillment_instructions_shipped:raw_payload->line->fulfillmentInstructions->>shippedDate`;
  const caseSelect = 'id,order_id,order_number,buyer_username,ebay_return_id,source_lane,issue_kind,status,ebay_status,provider_return_id:raw_payload->>ebayReturnId,detail_return_id:raw_payload->ebayDetail->>returnId,summary_return_id:raw_payload->ebaySummary->>returnId,actual_refund:raw_payload->ebayDetail->refundInfo->actualRefundDetail,return_state:raw_payload->>returnState,summary_state:raw_payload->ebaySummary->>state,requested_at:raw_payload->>requestedAt,api_requested_at:raw_payload->apiExtractedDetails->>requestedAt,creation_date:raw_payload->ebayDetail->creationInfo->creationDate';
  function buyerOr(buyers) {
    // Escape LIKE wildcards first, then PostgREST's quoted OR grammar.
    return buyers.map(buyer => {
      const pattern = String(buyer).trim().replace(/[\\%_*]/g, '\\$&');
      return `buyer_username.ilike."${pattern.replace(/[\\"]/g, '\\$&')}"`;
    }).join(',');
  }
  async function paged(makeQuery) {
    const rows = [], size = 250;
    for (let start = 0; ; start += size) {
      const {data, error} = await makeQuery().order('id').range(start, start + size - 1);
      if (error) throw new Error(error.message || 'Could not check buyer refunds.');
      if (!Array.isArray(data)) throw new Error('Buyer refund history was not returned.');
      rows.push(...data);
      if (data.length < size) return unique(rows);
    }
  }
  async function batches(values, size, read) {
    const chunks = [], results = [];
    for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
    let next = 0;
    await Promise.all(Array.from({length:Math.min(2,chunks.length)}, async () => {
      while (next < chunks.length) { const index = next++; results[index] = await read(chunks[index]); }
    }));
    return unique(results.flat());
  }
  function signalRaw(row) {
    return {orderPaymentStatus:row.payment_status,source:row.source,orderFulfillmentStatus:row.fulfillment_status,orderCancelStatus:row.cancel_status,
      order:{orderPaymentStatus:row.order_payment_status,orderFulfillmentStatus:row.order_fulfillment_status,cancelStatus:row.order_cancel},
      api_order_status:{payment_status:row.api_payment_status,fulfillment_status:row.api_fulfillment_status,cancel_status:row.api_cancel_status},
      api_cancellation_case:row.api_cancel,cancellation_page_case:row.page_cancel,ebayFinance:{transactions:row.finance_transactions},
      history_date_corrected_at:row.history_corrected,line:{shippedDate:row.line_shipped,lineItemFulfillmentInstructions:{shippedDate:row.instructions_shipped},fulfillmentInstructions:{shippedDate:row.fulfillment_instructions_shipped}}};
  }
  function restoreOrder(row) {
    const raw = signalRaw(row);
    raw.order.paymentSummary = {refunds:row.payment_refunds};
    raw.order.pricingSummary = {total:row.order_total};
    raw.first_row = {Currency:row.import_currency,'Shipped On Date':row.csv_shipped};
    raw.date_precision = {shipped_on_date:row.shipped_precision};
    Object.assign(raw.order,{shippedDate:row.api_shipped,fulfillmentSummary:{shippedDate:row.summary_shipped},fulfillmentStatus:{shippedDate:row.status_shipped},
      shippingFulfillment:{shippedDate:row.fulfillment_shipped},fulfillments:row.fulfillments,shippingFulfillments:row.shipping_fulfillments});
    return {...row,raw_payload:raw};
  }
  function restoreCase(row) {
    return {...row,raw_payload:{ebayReturnId:row.provider_return_id,returnState:row.return_state,requestedAt:row.requested_at,apiExtractedDetails:{requestedAt:row.api_requested_at},
      ebaySummary:{returnId:row.summary_return_id,state:row.summary_state},
      ebayDetail:{returnId:row.detail_return_id,creationInfo:{creationDate:row.creation_date},refundInfo:{actualRefundDetail:row.actual_refund}}}};
  }
  async function loadRecords(client, buyers) {
    const names = [...new Set(buyers.map(key).filter(Boolean))], wanted = new Set(names);
    const orders = (await batches(names, 15, batch => paged(() => client.from('ebay_orders').select(orderSelect).or(buyerOr(batch)))))
      .filter(row => wanted.has(key(row.buyer_username))).map(restoreOrder);
    const ids = orders.map(row => row.id);
    const lines = (await batches(ids, 60, batch => paged(() => client.from('ebay_order_lines').select(lineSelect).in('order_id',batch))))
      .map(row => ({...row,raw_payload:signalRaw(row)}));
    const orderCases = await batches(ids, 60, batch => paged(() => client.from('ebay_return_cases').select(caseSelect).in('order_id',batch)));
    const buyerCases = (await batches(names, 15, batch => paged(() => client.from('ebay_return_cases').select(caseSelect).or(buyerOr(batch)))))
      .filter(row => wanted.has(key(row.buyer_username)));
    return {orders,lines,returnCases:unique([...orderCases,...buyerCases]).map(restoreCase)};
  }
  function summarize(records, buyers) {
    const result = new Map();
    for (const buyer of buyers) {
      const name = key(buyer), orders = records.orders.filter(order => key(order.buyer_username) === name);
      const ids = new Set(orders.map(order => order.id)), numbers = new Set(orders.map(order => order.order_number).filter(Boolean));
      const financial = refunds.model({orders,lines:records.lines.filter(line => ids.has(line.order_id)),
        returnCases:records.returnCases.filter(c => key(c.buyer_username) === name || ids.has(c.order_id) || (!c.order_id && numbers.has(c.order_number)))});
      const confirmed = financial.refundedOrders, requested = financial.requestedOrders;
      const verification = financial.orders.filter(order => order.unknown || order.failed).length + financial.unmatched.length;
      const cancelled=financial.orders.filter(o=>o.timing.cancelled).length, timing=refunds.timingCounts(financial);
      timing.timing_unknown+=financial.unmatched.length;
      const timingByStatus=Object.fromEntries(['confirmed','requested','verification'].map(status=>{
        const selected=financial.orders.filter(o=>status==='confirmed'?o.refundCents>0:status==='requested'?o.pending || o.requests.some(r=>r.state==='requested'):o.unknown || o.failed);
        return [status,refunds.timingCounts({orders:selected})];
      }));
      timingByStatus.verification.timing_unknown+=financial.unmatched.length;
      const category = confirmed ? 'confirmed' : requested ? 'requested' : verification ? 'verification' : cancelled ? 'cancelled' : orders.length ? 'none' : 'unknown';
      const timingCategory=['after_shipment','after_completion','before_shipment','timing_unknown'].find(k=>timing[k]>0) || (orders.length?'none':'unknown');
      result.set(name,{confirmed,requested,verification,cancelled,category,timingCategory,timingByStatus,...timing,orderCount:orders.length});
    }
    return result;
  }
  function createController({client,getLines,onChange=()=>{},document:doc=root.document,read=loadRecords}) {
    const el = id => doc?.getElementById(id);
    let records = new Map(), status = 'idle', generation = 0, pending = null, checked = false, checkedAt = '';
    const filterValue = () => el('buyer-refund-filter')?.value || 'all';
    const timingValue = () => el('buyer-refund-timing')?.value || 'all';
    const grouping = () => el('order-sort')?.value === 'refund_history';
    const active = () => filterValue() !== 'all' || timingValue() !== 'all' || grouping();
    const buyers = () => [...new Set(getLines().map(line => key(line.order?.buyer_username)).filter(Boolean))];
    function updateControls() {
      const button = el('buyer-refund-refresh'), note = el('buyer-refund-status');
      if (button) {button.disabled = status === 'loading';button.textContent = status === 'loading' ? 'Checking…' : checked ? 'Refresh buyer refunds' : 'Check buyer refunds';}
      if (!note) return;
      note.dataset.state = status;
      if (status === 'loading') note.textContent = 'Checking saved purchase history, including closed orders…';
      else if (status === 'error') note.textContent = 'Could not check buyer history. Click Refresh buyer refunds to retry; unknown history is not treated as no refunds.';
      else if (status === 'ready') {
        const all = [...records.values()], count = name => all.filter(row => row[name] > 0).length;
        note.textContent = `${all.length} buyers checked · ${count('confirmed')} with completed refunds · ${count('requested')} with requests / pending refunds. Timing: ${count('after_shipment')} after shipment · ${count('before_shipment')} before shipment · ${count('after_completion')} after system completion (shipment unconfirmed) · ${count('timing_unknown')} to verify. Buyer counts can overlap. Checked ${checkedAt}.`;
      } else note.textContent = 'Check saved buyer history, including closed orders. Each buyer’s current orders stay together.';
    }
    function ensure(force = false) {
      if (!force && pending) return pending;
      if (!force && status === 'ready') return Promise.resolve();
      checked = true; status = 'loading'; records = new Map();
      const run = ++generation, names = buyers();
      updateControls(); onChange();
      pending = (async () => {
        try {
          const saved = await read(client,names);
          if (run !== generation) return;
          records = summarize(saved,names); status = 'ready';
          checkedAt = new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
        } catch (error) {
          if (run !== generation) return;
          status = 'error'; console.warn('Buyer refund history could not be checked:',error);
        } finally {
          if (run === generation) {pending = null;updateControls();onChange();}
        }
      })();
      return pending;
    }
    function queueChanged() {
      generation++; pending = null; records = new Map(); status = 'idle';
      if (checked || active()) return ensure();
      updateControls();
      return Promise.resolve();
    }
    function category(buyer) {
      const summary=status==='ready' && records.get(key(buyer));if(!summary)return 'unknown';
      const counts=summary.timingByStatus[filterValue()] || summary;
      if(timingValue()!=='all' && counts[timingValue()]>0)return timingValue();
      return ['after_shipment','after_completion','before_shipment','timing_unknown'].find(k=>counts[k]>0) || summary.timingCategory;
    }
    function filter(lines) {
      const value = filterValue(), timing = timingValue();
      if (value === 'all' && timing === 'all') return lines;
      if (status !== 'ready') return [];
      return lines.filter(line => {
        const summary = records.get(key(line.order?.buyer_username));
        return summary && (value === 'all' || (value === 'none' ? summary.timingCategory === 'none' : summary[value] > 0))
          && (timing === 'all' || (summary.timingByStatus[value] || summary)[timing] > 0);
      });
    }
    function badge(buyer) {
      const summary = status === 'ready' && records.get(key(buyer));
      if (!summary) return '';
      const parts = [];
      if (summary.confirmed) parts.push(`${summary.confirmed} refunded order${summary.confirmed === 1 ? '' : 's'}`);
      if (summary.requested) parts.push(`${summary.requested} request${summary.requested === 1 ? '' : 's'} / pending`);
      if (summary.verification) parts.push(`${summary.verification} to verify`);
      if (summary.cancelled && !summary.confirmed) parts.push(`${summary.cancelled} cancelled order${summary.cancelled===1?'':'s'}`);
      for(const [key,label] of [['after_shipment','after shipment'],['before_shipment','before shipment'],['after_completion','after system completion (shipment unconfirmed)'],['timing_unknown','timing unconfirmed']])if(summary[key])parts.push(`${summary[key]} ${label}`);
      if (!parts.length) parts.push(summary.timingCategory==='unknown'?'History not confirmed':'No refunds or cancellations recorded');
      return `<a class="buyer-refund-badge is-${summary.timingCategory}" href="ebay-buyer-report.html?buyer=${encodeURIComponent(buyer)}" target="_blank" rel="noopener" title="Saved buyer history across ${summary.orderCount} orders, including closed orders. Timing counts are orders with refund, request or cancellation activity, separate from refund payment status. Open purchase report for dates and evidence.">Buyer history: ${html(parts.join(' · '))}</a>`;
    }
    function heading(group, index, groups) {
      if (!grouping()) return '';
      const kind = category(group.buyer);
      if (index && category(groups[index - 1].buyer) === kind) return '';
      const count = groups.filter(row => category(row.buyer) === kind).length;
      const label = kind === 'unknown' && status === 'loading' ? 'Checking buyer refund history…' : kind === 'unknown' && status === 'error' ? 'Buyer refund history unavailable' : labels[kind];
      return `<h3 class="buyer-refund-section is-${kind}">${label}<span>${count} buyer${count === 1 ? '' : 's'}</span></h3>`;
    }
    function init() {
      for(const id of ['buyer-refund-filter','buyer-refund-timing'])el(id)?.addEventListener('change',() => {
        if (active()) void ensure();
        updateControls();onChange();
      });
      el('buyer-refund-refresh')?.addEventListener('click',() => void ensure(true));
      updateControls();
    }
    return {init,ensure,queueChanged,filter,badge,heading,category,
      sortChanged:() => {if (grouping()) void ensure();},
      compare:(a,b) => ranks[category(a.buyer)] - ranks[category(b.buyer)] || (statusRanks[records.get(key(a.buyer))?.category]||0) - (statusRanks[records.get(key(b.buyer))?.category]||0),
      emptyMessage:() => filterValue() === 'all' && timingValue() === 'all' ? '' : status === 'loading' ? 'Checking buyer refund history…' : status === 'error' ? 'Buyer history could not be checked. Use Refresh buyer refunds to retry.' : 'No buyers match these refund / timing filters and the other selected filters.',
      snapshot:() => ({status,records:new Map(records)})};
  }
  const api = {createController,loadRecords,summarize,buyerOr,init(options) {
    const controller = createController(options);
    Object.assign(api,controller);controller.init();
  }};
  root.OGPendingBuyerRefunds = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
