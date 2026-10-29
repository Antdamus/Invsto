/* Buyer history is read on demand; it never changes fulfillment or refund records. */
(function(root) {
  'use strict';
  const refunds = root.OGBuyerRefundReport || (typeof require === 'function' ? require('./buyer-report-refunds.js') : null);
  const key = value => String(value || '').trim().toLowerCase();
  const unique = rows => [...new Map(rows.map(row => [row.id, row])).values()];
  const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const labels = {confirmed:'Buyers with completed refunds',requested:'Buyers with requests / pending refunds',
    verification:'Buyers with refund records to verify',none:'Buyers with no refunds recorded',unknown:'Buyer history not checked'};
  const ranks = {confirmed:0,requested:1,verification:2,none:3,unknown:4};
  const signalSelect = 'payment_status:raw_payload->>orderPaymentStatus,order_payment_status:raw_payload->order->>orderPaymentStatus,api_payment_status:raw_payload->api_order_status->>payment_status,finance_transactions:raw_payload->ebayFinance->transactions';
  const orderSelect = `id,order_number,buyer_username,total_price,${signalSelect},payment_refunds:raw_payload->order->paymentSummary->refunds,order_total:raw_payload->order->pricingSummary->total,import_currency:raw_payload->first_row->>Currency`;
  const lineSelect = `id,order_id,${signalSelect}`;
  const caseSelect = 'id,order_id,order_number,buyer_username,ebay_return_id,source_lane,issue_kind,status,ebay_status,provider_return_id:raw_payload->>ebayReturnId,detail_return_id:raw_payload->ebayDetail->>returnId,summary_return_id:raw_payload->ebaySummary->>returnId,actual_refund:raw_payload->ebayDetail->refundInfo->actualRefundDetail,return_state:raw_payload->>returnState,summary_state:raw_payload->ebaySummary->>state';
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
    return {orderPaymentStatus:row.payment_status,order:{orderPaymentStatus:row.order_payment_status},
      api_order_status:{payment_status:row.api_payment_status},ebayFinance:{transactions:row.finance_transactions}};
  }
  function restoreOrder(row) {
    const raw = signalRaw(row);
    raw.order.paymentSummary = {refunds:row.payment_refunds};
    raw.order.pricingSummary = {total:row.order_total};
    raw.first_row = {Currency:row.import_currency};
    return {...row,raw_payload:raw};
  }
  function restoreCase(row) {
    return {...row,raw_payload:{ebayReturnId:row.provider_return_id,returnState:row.return_state,
      ebaySummary:{returnId:row.summary_return_id,state:row.summary_state},
      ebayDetail:{returnId:row.detail_return_id,refundInfo:{actualRefundDetail:row.actual_refund}}}};
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
      const category = confirmed ? 'confirmed' : requested ? 'requested' : verification ? 'verification' : orders.length ? 'none' : 'unknown';
      result.set(name,{confirmed,requested,verification,category,orderCount:orders.length});
    }
    return result;
  }
  function createController({client,getLines,onChange=()=>{},document:doc=root.document,read=loadRecords}) {
    const el = id => doc?.getElementById(id);
    let records = new Map(), status = 'idle', generation = 0, pending = null, checked = false, checkedAt = '';
    const filterValue = () => el('buyer-refund-filter')?.value || 'all';
    const grouping = () => el('order-sort')?.value === 'refund_history';
    const active = () => filterValue() !== 'all' || grouping();
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
        note.textContent = `${all.length} buyers checked · ${count('confirmed')} with completed refunds · ${count('requested')} with requests / pending refunds · ${count('verification')} to verify. Counts can overlap. Checked ${checkedAt}.`;
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
    function category(buyer) {return status === 'ready' ? records.get(key(buyer))?.category || 'unknown' : 'unknown';}
    function filter(lines) {
      const value = filterValue();
      if (value === 'all') return lines;
      if (status !== 'ready') return [];
      return lines.filter(line => {
        const summary = records.get(key(line.order?.buyer_username));
        return summary && (value === 'none' ? summary.category === 'none' : summary[value] > 0);
      });
    }
    function badge(buyer) {
      const summary = status === 'ready' && records.get(key(buyer));
      if (!summary) return '';
      const parts = [];
      if (summary.confirmed) parts.push(`${summary.confirmed} refunded order${summary.confirmed === 1 ? '' : 's'}`);
      if (summary.requested) parts.push(`${summary.requested} request${summary.requested === 1 ? '' : 's'} / pending`);
      if (summary.verification) parts.push(`${summary.verification} to verify`);
      if (!parts.length) parts.push('No refunds recorded');
      return `<a class="buyer-refund-badge is-${summary.category}" href="ebay-buyer-report.html?buyer=${encodeURIComponent(buyer)}" target="_blank" rel="noopener" title="Saved buyer history across ${summary.orderCount} orders, including closed orders. Open purchase report for details.">Buyer history: ${html(parts.join(' · '))}</a>`;
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
      el('buyer-refund-filter')?.addEventListener('change',() => {
        if (active()) void ensure();
        updateControls();onChange();
      });
      el('buyer-refund-refresh')?.addEventListener('click',() => void ensure(true));
      updateControls();
    }
    return {init,ensure,queueChanged,filter,badge,heading,category,
      sortChanged:() => {if (grouping()) void ensure();},
      compare:(a,b) => ranks[category(a.buyer)] - ranks[category(b.buyer)],
      emptyMessage:() => filterValue() === 'all' ? '' : status === 'loading' ? 'Checking buyer refund history…' : status === 'error' ? 'Buyer history could not be checked. Use Refresh buyer refunds to retry.' : 'No buyers match this refund filter and the other selected filters.',
      snapshot:() => ({status,records:new Map(records)})};
  }
  const api = {createController,loadRecords,summarize,buyerOr,init(options) {
    const controller = createController(options);
    Object.assign(api,controller);controller.init();
  }};
  root.OGPendingBuyerRefunds = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
