(() => {
  const $ = id => document.getElementById(id);
  if (!$('item-pricing-mode')) return;
  let config = null, requestedOwner = '', loading;
  const deferred = () => $('item-pricing-mode').value !== 'now';
  function apply() {
    const pending = deferred();
    $('item-pricing-fields').hidden = pending;
    $('item-pricing-assignment').hidden = !pending;
    ['cost','sale-price','minimum-sale-price','price-per-weight','auto-cost-checkbox'].forEach(id => {
      $(id).disabled = pending || (['price-per-weight','auto-cost-checkbox'].includes(id) && window.addItemWizard?.usesDirectPricing());
    });
    $('cost').required = !pending;
    $('sale-price').required = !pending;
    $('item-pricing-owner').required = pending;
    $('item-pricing-owner').disabled = !pending || !config;
    if($('item-keep-prices')){$('item-keep-prices').closest('label').hidden=pending;if(pending)$('item-keep-prices').checked=false;}
    window.addItemWizard?.renderReview();
  }
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const {data,error} = await window.supabase.rpc('inventory_pricing_config');
        if (error) throw error;
        config = data;
        const select = $('item-pricing-owner');
        select.replaceChildren(new Option('Choose pricing owner',''));
        for (const owner of config.owners) select.add(new Option(owner.name,owner.user_id));
        select.value = requestedOwner || config.default_owner || '';
        $('item-pricing-status').textContent = config.default_owner ? 'Cost and selling prices stay blank until reviewed. The item is held out of eBay sync while awaiting pricing.' : 'Choose a pricing owner. An administrator can set the default in Pricing.';
        $('item-pricing-retry').hidden = true;
      } catch (error) {
        $('item-pricing-status').textContent = 'Could not load pricing owners. Retry before saving, or choose Set prices now.';
        $('item-pricing-retry').hidden = false;
      } finally { apply(); loading = null; }
    })();
    return loading;
  }
  window.addItemPricing = {
    deferred,
    ownerName: () => $('item-pricing-owner').selectedOptions[0]?.textContent || 'pricing owner',
    getDraft: () => ({mode:$('item-pricing-mode').value,owner:$('item-pricing-owner').value || requestedOwner}),
    restore(draft) { $('item-pricing-mode').value = draft?.mode === 'now' ? 'now' : 'later'; requestedOwner = draft?.owner || ''; if(config)$('item-pricing-owner').value=requestedOwner || config.default_owner || ''; apply(); },
    validate() { return !deferred() || Boolean(config && $('item-pricing-owner').value); },
    fields() { if (!this.validate()) throw new Error('Choose a pricing owner before saving.'); return deferred() ? {pricing_status:'pending',pricing_owner:$('item-pricing-owner').value} : {pricing_status:'ready'}; },
    apply
  };
  $('item-pricing-mode').addEventListener('change',()=>{apply();document.dispatchEvent(new Event('add-item:wizard-change'));});
  $('item-pricing-owner').addEventListener('change',()=>{requestedOwner=$('item-pricing-owner').value;document.dispatchEvent(new Event('add-item:wizard-change'));});
  $('item-pricing-retry').addEventListener('click',load);
  document.addEventListener('add-item:mode-change',apply);
  document.addEventListener('add-item-form:reset',()=>window.addItemPricing.restore());
  document.addEventListener('DOMContentLoaded',load);
  apply();
})();
