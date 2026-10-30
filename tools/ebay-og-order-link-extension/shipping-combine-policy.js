/* Shared, DOM-independent shipping safety decision. */
(function (root) {
  'use strict';
  const unique = values => [...new Set(values.filter(value => /^\d{2}-\d{5}-\d{5}$/.test(value)))];
  function assess({shipments = [], priorities = [], ready = false, nativeCanCombine = false} = {}) {
    const orderNumbers = unique(shipments.flatMap(row => row.orderNumbers || []));
    const block = (reason, extra = {}) => ({blocked:true,reason,orderNumbers,...extra});
    if (!orderNumbers.length) return block('Waiting for eBay to load the shipping orders.');
    if (!ready) return block('Open Invsto Pending Orders and wait for it to load, then check again. The selected orders must be verified before buying labels.');
    const groups = priorities.filter(group => group.orderNumbers?.some(number => orderNumbers.includes(number)));
    const known = new Set(groups.flatMap(group => group.orderNumbers || []));
    if (orderNumbers.some(number => !known.has(number))) return block('Some orders are not in the current Invsto pending queue. Sync Pending Orders, then check again before creating labels.');
    for (const group of groups) {
      const selectedLines = Array.isArray(group.lines) ? group.lines.filter(line => orderNumbers.includes(line.orderNumber)) : [];
      if (!selectedLines?.length || selectedLines.some(line => typeof line.shippingEligible !== 'boolean')) {
        return block('Refresh Invsto Pending Orders to load the current combined-shipping safety check.');
      }
      const blockedLine = selectedLines.find(line => line.shippingBlockReason || !line.shippingEligible);
      if (blockedLine) return block(`${blockedLine.orderNumber}: ${blockedLine.shippingBlockReason || 'Not eligible for shipping'}. Review it in Invsto before shipping.`);
      // Only orders on this shipping page are in the package. An unchecked
      // order for the same buyer must never be pulled into this label.
    }
    const allOrders = orderNumbers;
    for (const group of groups) {
      const included = new Set(group.orderNumbers.filter(number => orderNumbers.includes(number)));
      if (shipments.filter(row => row.orderNumbers?.some(number => included.has(number))).length > 1) {
        return block('Combine this buyer’s selected orders into one package before buying labels.',{action:'combine',orderNumbers:allOrders});
      }
    }
    if (nativeCanCombine) return block('eBay still has orders that can be combined. Combine them before buying labels.',{action:'combine',orderNumbers:allOrders});
    return {blocked:false,reason:'Selected orders verified. Other pending orders are not included. Review the package weight and dimensions before buying.',orderNumbers:allOrders};
  }
  if (typeof module === 'object' && module.exports) module.exports = {assess};
  else root.OGShippingCombinePolicy = {assess};
})(globalThis);
