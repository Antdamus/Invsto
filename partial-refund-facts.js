/* Stable approval comparison. Keep in parity with the database review helpers. */
(() => {
  'use strict';
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
    : value ?? null;
  const key = value => JSON.stringify(canonical(value));
  const sorted = values => values.map(canonical).sort((a,b) => key(a).localeCompare(key(b)));
  const clearPayments = ['PAID','PARTIALLY_REFUNDED'];
  const clearCancellations = ['NONE_REQUESTED','NOT_REQUESTED','NO_CANCEL','NOT_CANCELLED','CANCEL_REJECTED','CANCEL_CLOSED_WITHOUT_REFUND'];
  const settled = ['REFUNDED','SUCCEEDED','COMPLETED','FUNDS_AVAILABLE','FUNDS_AVAILABLE_FOR_PAYOUT','FUNDS_ON_HOLD','FUNDS_PAID_OUT'];
  const statuses = (values, ignored) => [...new Set((values || []).map(v => String(v || '').trim().toUpperCase()).filter(v => v && !ignored.includes(v)))].sort();
  const core = facts => {
    const {refunds,transactions,payments,cancellations,...rest} = facts || {};
    return {...rest,payments:statuses(payments,clearPayments),cancellations:statuses(cancellations,clearCancellations)};
  };
  function evidence(records,kind) {
    const normalized = (Array.isArray(records) ? records : []).map(t => {
      const amount = t.amount?.value ?? (typeof t.amount === 'number' || typeof t.amount === 'string' ? t.amount : null);
      const status = String(kind === 'transactions' ? t.transactionStatus || '' : t.refundStatus || '').toUpperCase();
      const date = kind === 'transactions' ? t.transactionDate : t.refundDate;
      const time = /(Z|[+-][0-9]{2}:[0-9]{2})$/.test(date || '') ? Date.parse(date)/1000 : NaN;
      return {
        id:String(kind === 'transactions' ? t.transactionId || '' : t.refundId || t.refundReferenceId || ''),
        amount:amount != null && /^-?[0-9]+(\.[0-9]+)?$/.test(String(amount)) ? Number(amount) : amount,
        currency:String(t.amount?.currency || t.currency || '').toUpperCase(),
        state:settled.includes(status) ? 'SETTLED' : status,
        at:Number.isFinite(time) ? time : null,
        booking:kind === 'transactions' ? String(t.bookingEntry || '').toUpperCase() : '',
        lines:kind === 'transactions' && Array.isArray(t.lineItemIds) ? sorted(t.lineItemIds) : [],
      };
    });
    return sorted(normalized.filter((t,i) => !t.id || normalized.findIndex(other => key(other) === key(t)) === i));
  }
  function sameReceipt(a,b) {
    return Boolean(a.id && b.id && a.state === 'SETTLED' && b.state === 'SETTLED'
      && typeof a.amount === 'number' && a.amount === b.amount && a.currency && a.currency === b.currency
      && ['', 'DEBIT'].includes(a.booking) && ['', 'DEBIT'].includes(b.booking)
      && a.at != null && b.at != null && Math.abs(a.at-b.at) <= 120);
  }
  function evidenceMatches(a,b,crossFeed) {
    if (!crossFeed) return key(a) === key(b);
    return a.length > 0 && a.length === b.length
      && a.every(x => b.filter(y => sameReceipt(x,y)).length === 1)
      && b.every(y => a.filter(x => sameReceipt(x,y)).length === 1);
  }
  function sources(snapshot) {
    return [['order',snapshot.order],...(snapshot.lines || []).map(l => [`line:${l.id}`,l.facts])]
      .flatMap(([path,facts]) => ['refunds','transactions'].map(kind => ({path:`${path}.${kind}`,kind,evidence:evidence(facts?.[kind],kind)})));
  }
  const snapshotCore = s => ({order:core(s.order),lines:(s.lines || []).map(l => ({id:l.id,facts:core(l.facts)})).sort((a,b) => String(a.id).localeCompare(String(b.id)))});
  function matches(a,b) {
    if (!a || !b || key(snapshotCore(a)) !== key(snapshotCore(b))) return false;
    const oldSources = sources(a),newSources = sources(b);
    for (const path of new Set([...oldSources,...newSources].map(s => s.path))) {
      const oldSource = oldSources.find(s => s.path === path),newSource = newSources.find(s => s.path === path);
      const before = oldSource?.evidence || [],after = newSource?.evidence || [];
      if (key(before) === key(after)) continue;
      if (before.length && after.length) return false;
      const source = before.length ? oldSource : newSource;
      const others = before.length ? newSources : oldSources;
      if (!others.some(other => evidenceMatches(source.evidence,other.evidence,source.kind !== other.kind))) return false;
    }
    return true;
  }
  window.OGPartialRefundFacts = {matches};
})();
