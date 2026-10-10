/* Shared, DOM-independent shipping safety decision. */
(function (root) {
  'use strict';
  const unique = values => [...new Set(values.filter(value => /^\d{2}-\d{5}-\d{5}$/.test(value)))];
  function assess({shipments = [], priorities = [], ready = false, nativeCanCombine = false, single = false} = {}) {
    const orderNumbers = unique(shipments.flatMap(row => row.orderNumbers || []));
    const block = (reason, extra = {}) => ({blocked:true,reason,orderNumbers,...extra});
    if (!orderNumbers.length) return block('Waiting for eBay to load the shipping orders.');
    if (!ready) return block('Open Invsto Pending Orders and wait for it to load, then check again. Separate labels stay blocked until the buyer’s full order is verified.');
    const groups = priorities.filter(group => group.orderNumbers?.some(number => orderNumbers.includes(number)));
    const known = new Set(groups.flatMap(group => group.orderNumbers || []));
    if (orderNumbers.some(number => !known.has(number))) return block('Some orders are not in the current Invsto pending queue. Sync Pending Orders, then check again before creating labels.');
    const required = new Set(orderNumbers);
    for (const group of groups) {
      if (!Array.isArray(group.lines) || group.lines.some(line => typeof line.shippingEligible !== 'boolean')) {
        return block('Refresh Invsto Pending Orders to load the current combined-shipping safety check.');
      }
      const blockedLine = group.lines.find(line => orderNumbers.includes(line.orderNumber) && line.shippingBlockReason);
      if (blockedLine) return block(`${blockedLine.orderNumber}: ${blockedLine.shippingBlockReason}. Review it in Invsto before shipping.`);
      const eligible = unique(group.lines.filter(line => line.shippingEligible).map(line => line.orderNumber));
      if (group.lines.some(line => line.shippingEligible && !/^\d{2}-\d{5}-\d{5}$/.test(line.orderNumber || ''))) {
        return block('A pending item is missing its eBay order number. Fix it in Invsto before creating the combined label.');
      }
      eligible.forEach(number => required.add(number));
    }
    const allOrders = [...required];
    const missing = allOrders.filter(number => !orderNumbers.includes(number));
    if (missing.length || (single && allOrders.length > 1)) {
      return block('This buyer has more pending orders. Load them together and create one combined label.',{action:'load',orderNumbers:allOrders});
    }
    for (const group of groups) {
      const included = new Set(group.orderNumbers.filter(number => orderNumbers.includes(number)));
      if (shipments.filter(row => row.orderNumbers?.some(number => included.has(number))).length > 1) {
        return block('Combine this buyer’s orders into one package before buying labels. Separate labels are blocked.',{action:'combine',orderNumbers:allOrders});
      }
    }
    if (nativeCanCombine) return block('eBay still has orders that can be combined. Combine them before buying labels.',{action:'combine',orderNumbers:allOrders});
    return {blocked:false,reason:'One package per buyer verified. Review the package weight and dimensions before buying.',orderNumbers:allOrders};
  }
  if (typeof module === 'object' && module.exports) module.exports = {assess};
  else root.OGShippingCombinePolicy = {assess};
})(globalThis);
