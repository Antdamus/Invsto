(function(root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const unique = values => [...new Set(values.filter(Boolean).map(String))];
  const order = line => line.order || line.ebay_orders || {};
  const evidence = line => line.raw_payload?.shipping_reconciliation || null;
  function metadataTracking(metadata = {}) {
    return unique([metadata.trackingNumber, metadata.shippingBarcodeNumber,
      ...(metadata.trackingNumbers || []), ...(metadata.shippingBarcodeNumbers || []),
      ...(metadata.labelRows || []).flatMap(row => metadataTracking(row))]);
  }
  function tracking(line) {
    const o = order(line);
    return unique([...(evidence(line)?.shipments || []).map(s => s.trackingNumber),
      ...metadataTracking(line.label_metadata), ...metadataTracking(o.label_metadata),
      o.tracking_number, line.raw_payload?.tracking_number, o.raw_payload?.tracking_number,
      o.raw_payload?.first_row?.['Tracking Number']]);
  }
  function search(line) {
    return [...tracking(line), evidence(line)?.note || ''].join(' ').toLowerCase();
  }
  function matchesTracking(line, term) {
    if (root.OGTrackingSearch?.isScan(term)) return tracking(line).some(t => root.OGTrackingSearch.matches(t, term));
    const compact = String(term || '').replace(/[\s-]/g,'').toLowerCase();
    return compact.length >= 6 && /^[a-z0-9]+$/.test(compact) &&
      tracking(line).some(t => t.replace(/[\s-]/g,'').toLowerCase().includes(compact));
  }
  function trackingUrl(s, orderNumber) {
    const t = encodeURIComponent(s.trackingNumber || '');
    const c = String(s.carrier || '').toLowerCase();
    if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
    if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
    if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${t}`;
    return `https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(orderNumber || '')}`;
  }
  function link(s, orderNumber) {
    return `<a href="${escape(trackingUrl(s,orderNumber))}" target="_blank" rel="noopener">${escape(s.carrier || 'Tracking')} ${escape(s.trackingNumber)}</a>`;
  }
  function lineMarkup(line) {
    const e = evidence(line);
    if (!e?.note || !e.shipments?.length) return '';
    return `<section class="shipment-verification shipment-verification-line" aria-label="Shipment verification">
      <span class="shipment-verification-kicker">eBay marked shipped · Pending in Invsto</span>
      <strong>${escape(e.note)}</strong>
      <div class="shipment-verification-tracking">${e.shipments.map(s => link(s,order(line).order_number)).join('')}</div>
      <small>${unique(e.shipments.map(s => {
        const d = new Date(s.shippedAt);
        return Number.isFinite(+d) ? new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(d) : '';
      })).map(escape).join(' · ')} · Shipment record from eBay</small>
    </section>`;
  }
  function groupMarkup(lines) {
    const marked = lines.filter(l => evidence(l)?.note && evidence(l)?.shipments?.length);
    if (!marked.length) return '';
    const shipments = new Map();
    for (const l of marked) for (const s of evidence(l).shipments) shipments.set(s.trackingNumber,{...s,orderNumber:order(l).order_number});
    return `<section class="shipment-verification shipment-verification-group" aria-label="Group shipment verification">
      <span class="shipment-verification-kicker">eBay shipment recorded</span>
      <strong>${unique(marked.map(l => evidence(l).note)).map(escape).join(' · ')}</strong>
      <span>${marked.length} of ${lines.length} pending item lines · ${new Set(marked.map(l => l.order_id || order(l).id)).size} orders · ${shipments.size} ${shipments.size===1?'package':'packages'}</span>
      <div class="shipment-verification-tracking">${[...shipments.values()].map(s=>link(s,s.orderNumber)).join('')}</div>
    </section>`;
  }
  const api = {tracking,search,matchesTracking,lineMarkup,groupMarkup};
  if (typeof module !== 'undefined') module.exports = api;
  root.OGPendingShipments = api;
})(typeof window !== 'undefined' ? window : globalThis);
